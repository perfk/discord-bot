import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import * as fs from 'fs';
import * as mongo from 'mongodb';
import { InjectDb } from 'nest-mongodb';

interface AdminStats {
  players: number;
  connected_players: Record<string, string>;
  mission: string;
  uptime_seconds: number;
  updated: number;
  fps: number;
  registered_entities: number;
  registered_vehicles: number;
  registered_groups: number;
  registered_systems: number;
  ai_characters: number;
  registered_tasks: number;
  events: number;
}

const MIN_PLAYERS_TO_OPEN = 10;
const STALE_THRESHOLD_SECONDS = 600;

@Injectable()
export class SessionService implements OnModuleInit {
  private readonly logger = new Logger('session');

  private activeSessionId: mongo.ObjectId | null = null;
  private lastUptime = 0;
  private lastMission = '';
  private lastUpdated = 0;

  constructor(@InjectDb() private readonly db: mongo.Db) {}

  async onModuleInit(): Promise<void> {
    await this.closeOrphanedSessions();
    await this.createIndexes();
    this.runPollLoop();
  }

  private async runPollLoop() {
    try {
      await this.poll();
    } catch (e) {
      this.logger.error('Error during poll:', e);
    }
    
    let intervalMs = 120000; // default 2 minutes
    try {
      const config = await this.db.collection('configs').findOne({}, { projection: { botPollIntervalMs: 1 } });
      if (config && typeof config.botPollIntervalMs === 'number') {
        intervalMs = config.botPollIntervalMs;
      }
    } catch (e) {
      this.logger.error('Error reading botPollIntervalMs from DB:', e);
    }

    setTimeout(() => this.runPollLoop(), intervalMs);
  }

  // ─── Private helpers ────────────────────────────────────────────────────────

  private async closeOrphanedSessions(): Promise<void> {
    try {
      // Close real sessions with their last snapshot time (or now if none)
      const realResult = await this.db.collection('server_sessions').updateMany(
        { endedAt: null, isPlaceholder: { $ne: true } },
        [
          {
            $set: {
              endedAt: {
                $ifNull: [{ $arrayElemAt: ['$snapshots.time', -1] }, new Date()],
              },
              endReason: 'stale',
            },
          },
        ],
      );
      // Close placeholders with their startedAt (0 duration)
      const placeholderResult = await this.db.collection('server_sessions').updateMany(
        { endedAt: null, isPlaceholder: true },
        [
          {
            $set: {
              endedAt: '$startedAt',
              endReason: 'stale',
            },
          },
        ],
      );

      const totalClosed = realResult.modifiedCount + placeholderResult.modifiedCount;
      if (totalClosed > 0) {
        this.logger.log(
          `closed ${totalClosed} orphaned session(s) from previous run (${realResult.modifiedCount} real, ${placeholderResult.modifiedCount} placeholders)`,
        );
      }
    } catch (err) {
      this.logger.error('failed to close orphaned sessions', err);
    }
  }

  private async createIndexes(): Promise<void> {
    try {
      const col = this.db.collection('server_sessions');
      await col.createIndex({ endedAt: 1 });
      await col.createIndex({ missionUniqueName: 1, startedAt: -1 });
    } catch (err) {
      this.logger.error('failed to create indexes', err);
    }
  }

  private async poll(): Promise<void> {
    try {
      const statsPath = process.env.REFORGER_SERVER_ADMIN_STATS_FILE;
      let stats: AdminStats;

      try {
        const raw = await fs.promises.readFile(statsPath, 'utf-8');
        stats = JSON.parse(raw);
      } catch (readErr) {
        this.logger.warn(`could not read stats file: ${readErr.message}`);
        if (this.activeSessionId && this.lastUpdated > 0) {
          const ageSeconds = Date.now() / 1000 - this.lastUpdated;
          if (ageSeconds > STALE_THRESHOLD_SECONDS) {
            await this.closeSession('stale');
          }
        }
        return;
      }

      // Staleness check — server-reported timestamp is too old
      const ageSeconds = Date.now() / 1000 - stats.updated;
      if (ageSeconds > STALE_THRESHOLD_SECONDS) {
        this.logger.warn(`stats are stale (${Math.round(ageSeconds)}s old)`);
        if (this.activeSessionId) {
          await this.closeSession('stale', new Date(stats.updated * 1000));
        }
        this.updateBaseline(stats);
        return;
      }

      // Boundary detection
      if (this.activeSessionId) {
        if (stats.uptime_seconds < this.lastUptime) {
          this.logger.log('server restart detected — closing session');
          await this.closeSession('server_restart');
        } else if (stats.mission !== this.lastMission) {
          this.logger.log(`mission change detected ("${this.lastMission}" → "${stats.mission}") — closing session`);
          await this.closeSession('mission_change');
        }
      }

      this.updateBaseline(stats);

      // Open or update session
      if (!this.activeSessionId && stats.players >= MIN_PLAYERS_TO_OPEN) {
        await this.openSession(stats);
      }

      if (this.activeSessionId) {
        await this.appendSnapshot(stats);
        await this.upsertPlayerMappings(stats.connected_players);
      }
    } catch (err) {
      this.logger.error(`poll() failed: ${err.message}`, err.stack);
    }
  }

  private updateBaseline(stats: AdminStats): void {
    this.lastUptime = stats.uptime_seconds;
    this.lastMission = stats.mission;
    this.lastUpdated = stats.updated;
  }

  private async openSession(stats: AdminStats): Promise<void> {
    const missionUniqueName = await this.matchMission(stats.mission);

    // Look for a recent placeholder for this mission to "adopt"
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const placeholder = await this.db.collection('server_sessions').findOne({
      missionUniqueName,
      isPlaceholder: true,
      endedAt: null,
      startedAt: { $gte: oneHourAgo },
    });

    if (placeholder) {
      this.activeSessionId = placeholder._id;
      await this.db.collection('server_sessions').updateOne(
        { _id: this.activeSessionId },
        {
          $set: {
            isPlaceholder: false,
            endReason: null,
            startedAt: new Date(),
            missionString: stats.mission, // Update with real string if it changed
          },
        },
      );
      this.logger.log(`adopted placeholder session ${this.activeSessionId} for "${stats.mission}"`);
    } else {
      const doc = {
        startedAt: new Date(),
        endedAt: null,
        missionString: stats.mission,
        missionUniqueName,
        snapshots: [],
        peakPlayerCount: stats.players,
        endReason: null,
      };
      const result = await this.db.collection('server_sessions').insertOne(doc);
      this.activeSessionId = result.insertedId;
      this.logger.log(
        `opened NEW session ${this.activeSessionId} for "${stats.mission}" (${stats.players} players)`,
      );
    }
  }

  private async closeSession(reason: string, endTime?: Date): Promise<void> {
    if (!this.activeSessionId) return;

    // Use provided endTime (e.g. from stale stats), or lastKnown activity, or current time
    const endedAt =
      endTime ??
      (this.lastUpdated > 0 ? new Date(this.lastUpdated * 1000) : new Date());

    await this.db.collection('server_sessions').updateOne(
      { _id: this.activeSessionId },
      { $set: { endedAt, endReason: reason } },
    );
    this.logger.log(
      `closed session ${this.activeSessionId} (reason: ${reason}, endedAt: ${endedAt.toISOString()})`,
    );
    this.activeSessionId = null;
  }

  private async appendSnapshot(stats: AdminStats): Promise<void> {
    const snapshot = {
      time: new Date(),
      players: stats.players,
      connectedPlayers: stats.connected_players,
      fps: stats.fps,
      uptime_seconds: stats.uptime_seconds,
      updated: stats.updated,
      registered_entities: stats.registered_entities,
      registered_vehicles: stats.registered_vehicles,
      registered_groups: stats.registered_groups,
      registered_systems: stats.registered_systems,
      ai_characters: stats.ai_characters,
      registered_tasks: stats.registered_tasks,
      events: stats.events,
    };
    await this.db.collection('server_sessions').updateOne(
      { _id: this.activeSessionId },
      {
        $push: { snapshots: snapshot },
        $max: { peakPlayerCount: stats.players },
      },
    );
  }

  private async upsertPlayerMappings(connectedPlayers: Record<string, string>): Promise<void> {
    for (const [platformId, playerName] of Object.entries(connectedPlayers)) {
      // Legacy support
      const result = await this.db.collection('configs').updateOne(
        { 'player_mappings.platformId': platformId },
        { $set: { 'player_mappings.$.playerName': playerName } },
      );
      if (result.matchedCount === 0) {
        await this.db.collection('configs').updateOne(
          {},
          { $push: { player_mappings: { platformId, playerName, discordId: null } } as any },
          { upsert: true },
        );
      }

      // UUCS: New Profiles
      await this.db.collection('user_profiles').updateOne(
        { platformIds: platformId },
        { 
          $set: { 
            lastKnownAlias: playerName,
            'stats.lastSeen': new Date()
          },
          $addToSet: {
            knownAliases: playerName
          },
          $setOnInsert: {
            discordId: null,
            username: playerName,
            platformIds: [platformId],
            notes: "",
            discordRoles: [],
            status: {
              isArmaBanned: false,
              isDiscordBanned: false,
              banExpiresAt: null,
              isLifeBanned: false,
              isBlacklisted: false,
              isProbationary: false,
            },
            stats: {
              warningCount: 0,
              banCount: 0,
              totalMinutes90d: 0,
              totalMinutes28d: 0,
              isMember: false,
            }
          }
        },
        { upsert: true }
      );
    }
  }

  private async matchMission(missionString: string): Promise<string | null> {
    const m = missionString.match(/^\w+\s+\([^)]+\)\s+(.+)$/);
    if (!m) return null;
    const name = m[1].trim();
    // Replace any run of non-alphanumeric chars (spaces, hyphens, underscores…)
    // with .* so "Race Day - Ruha" matches "RaceDay_Ruha", "race-day-ruha", etc.
    const nameForRegex = name.replace(/[^a-zA-Z0-9]+/g, '.*');
    const doc = await this.db.collection('reforger_missions').findOne({
      $or: [
        { missionName: { $regex: new RegExp('^' + name + '$', 'i') } },
        { uniqueName: { $regex: new RegExp(nameForRegex, 'i') } },
      ],
    });
    return (doc?.uniqueName as string) ?? null;
  }
}
