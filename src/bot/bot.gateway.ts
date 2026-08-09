/* eslint-disable prettier/prettier */
import { DiscordClientProvider, On, Once } from '@discord-nestjs/core';
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import { ActionRowBuilder, ActivityType, EmbedBuilder, Interaction, StringSelectMenuBuilder, TextChannel } from 'discord.js';
import * as fs from 'fs';
import { Player, QueryResult } from 'gamedig';
import * as mongo from 'mongodb';
import { InjectDb } from 'nest-mongodb';
import { COLOR_ERROR, COLOR_MAINTENANCE, COLOR_OK } from '../helpers/colors';
import locale from '../helpers/en';
import Server from '../helpers/server';
import Settings from '../polling/settings';

@Injectable()
export class BotGateway {
  private readonly logger = new Logger(BotGateway.name);
  private maintenanceMode: boolean;
  private reforgerServer = new Server(process.env.IP, parseInt(process.env.REFORGERPORT), 'armareforger')
  constructor(
    private readonly discordProvider: DiscordClientProvider,
    @InjectDb() private readonly db: mongo.Db,
  ) { }

  @Once('clientReady')
  onReady(): void {
    this.logger.log(
      `Logged in as ${this.discordProvider.getClient().user.tag}!`,
    );
    this.startPolling();
    this.loopPolling();
    console.info('Bot is running');
  }

  @On('interactionCreate')
  async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.channelId == process.env.DISCORD_VOTING_CHANNEL) {
      if (!interaction.isButton()) return;

      const uniqueName = interaction.customId;
      const clicker = interaction.user;
      //  this.db.collection("users")

      const voteCountResult = await this.db.collection('missions').count({
        votes: clicker.id,
      });

      if (voteCountResult >= 4) {
        try {
          await interaction.reply({
            content: 'You already voted for 4 different missions.',
            ephemeral: true,
          });
        } catch (error) {
          console.error(error);
        } finally {
          return;
        }
      }
      const updateResult = await this.db.collection('missions').updateOne(
        { uniqueName: uniqueName },
        {
          $addToSet: {
            votes: clicker.id,
          },
        },
      );
      try {
        if (updateResult.modifiedCount === 1) {
          await interaction.reply({
            content: 'Vote submitted!',
            ephemeral: true,
          });
        } else {
          await interaction.reply({
            content: 'You already voted for this mission.',
            ephemeral: true,
          });
        }
      } catch (error) {
        console.error(error);
      } finally {
        return;
      }
    }
    if (interaction.isButton() && interaction.customId && interaction.customId.startsWith('reforgerRate_')) {
      const parts = interaction.customId.split('_');
      // parts[0] = 'reforgerRate', parts[1] = uniqueName, parts[2] = historyEntryId
      const uniqueName = parts[1];
      const historyEntryId = parts[2] || 'unknown';
      const clicker = interaction.user;

      const missionFound = await this.db.collection('reforger_mission_metadata').findOne({
        missionId: uniqueName
      }) || await this.db.collection('reforger_mission_metadata').findOne({
        uniqueName: uniqueName
      });

      if (missionFound && missionFound.authorID == clicker.id) {
        await interaction.reply({
          content: 'You can\'t rate your own mission. 🤓',
          ephemeral: true,
        });
        return;
      }
      
      const row = new ActionRowBuilder<StringSelectMenuBuilder>()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId(`reforgerRateSelect_${uniqueName}_${historyEntryId}`)
            .setPlaceholder('Rate this specific session:')
            .addOptions(
              {
                label: 'Good',
                description: 'I liked this mission.',
                emoji: "👍",
                value: 'positive',
              },
              {
                label: 'Okay',
                description: 'This mission was fine.',
                emoji: "🆗",
                value: 'neutral',
              },
              {
                label: 'Bad',
                description: 'I did not like this mission.',
                emoji: "👎",
                value: 'negative',
              },
            ),
        );

      await interaction.reply({
        content: 'Submit your rating:',
        ephemeral: true,
        components: [row]
      });
      return;
    }

    if (interaction.isAnySelectMenu() && interaction.customId && interaction.customId.startsWith('reforgerRateSelect_')) {
      await interaction.deferUpdate();
      const parts = interaction.customId.split('_');
      const uniqueName = parts[1];
      const historyEntryId = parts[2] || 'unknown';
      const clicker = interaction.user;
      const value = interaction.values[0];

      const websiteUrl = process.env.WEBSITE_URL ?? 'http://globalconflicts.net';
      const url = `${websiteUrl}/api/reforger-missions/${uniqueName}/rate_mission`;
      try {
        await axios.post(
          url,
          { value: value, discordUserId: clicker.id, historyEntryId: historyEntryId },
          {
            headers: { 'x-api-secret': process.env.API_SECRET },
            timeout: 5000,
          }
        );
      } catch (error) {
        console.error("Error posting reforger rating", error);
      }

      if (value == "negative") {
        await interaction.editReply({ content: "Rating submited! 📝 If you didn't enjoy this mission, consider writing a constructive review for the mission maker.", components: [] })
      } else {
        await interaction.editReply({
          content: 'Thanks for your input!',
          components: []
        });
      };
      return;
    }

    /*
    if (interaction.channelId == process.env.DISCORD_BOT_AAR_CHANNEL) {
      if (interaction.isButton() && interaction.customId) {
        const uniqueName = interaction.customId;
        const clicker = interaction.user;


        const missionFound = await this.db.collection('missions').findOne({
          uniqueName: uniqueName
        })
        if (missionFound.authorID == clicker.id) {
          await interaction.reply({
            content: 'You can\'t rate your own mission. 🤓',
            ephemeral: true,
          });
          return;
        }
        if (!missionFound.history) {
          await interaction.reply({
            content: 'You can\'t rate a mission that hasn\'t been played yet.',
            ephemeral: true,
          });
          return;
        }

        const row = new ActionRowBuilder<StringSelectMenuBuilder>()
          .addComponents(
            new StringSelectMenuBuilder()
              .setCustomId(uniqueName)
              .setPlaceholder('Rate this playthrough:')
              .addOptions(
                {
                  label: 'Great',
                  description: 'This was a great playthrough',
                  emoji: "👍",
                  value: 'positive',
                },
                {
                  label: 'OK',
                  description: 'This was a perfectly OK playthrough',
                  emoji: "🆗",
                  value: 'neutral',
                },
                {
                  label: 'Bad',
                  description: 'I did not enjoy this playthrough',
                  emoji: "👎",
                  value: 'negative',
                },
              ),
          );

        await interaction.reply({
          content: 'Submit your rating:',
          ephemeral: true,
          components: [row]
        })

      }
      if (interaction.isAnySelectMenu()) {
        await interaction.deferUpdate();
        const uniqueName = interaction.customId;
        const clicker = interaction.user;

        const value = interaction["values"][0]
        const rating = {
          date: new Date(),
          ratingAuthorId: clicker.id,
          value: value,
        };
        const hasRating = await this.db.collection('missions').findOne(
          {
            uniqueName: uniqueName,
            "ratings.ratingAuthorId": clicker.id
          }
        );

        if (hasRating) {
          await this.db.collection("missions").updateOne(
            {
              uniqueName: uniqueName,
              "ratings.ratingAuthorId": clicker.id
            }, {
            $set: {
              "ratings.$.value": value,
              "ratings.$.date": new Date(),
            }
          }
          );
        } else {
          await this.db.collection('missions').updateOne(
            {
              uniqueName: uniqueName
            }, {
            $addToSet: { ratings: rating }
          }
          );
        }

        if (value == "negative") {
          await interaction.editReply({ content: "Rating submited! 📝 If you didn't enjoy this mission, consider writing a constructive review for the mission maker.", components: [] })
        } else {
          await interaction.editReply({
            content: 'Thanks for your input!',
            components: []

          });

        };
      }

    }
    */


  }

  async startPolling(forceNewMessage = false) {
    const discordClient = this.discordProvider.getClient();

    const serverViewerChannel: TextChannel = discordClient.channels.cache.get(
      process.env.SERVER_VIEWER_CHANNEL_ID,
    ) as TextChannel;

    if (this.maintenanceMode) {
      console.log('maintenanceMode');
      return;
    }

    const reforgerMessageId = Settings.get().reforgerMessageId

    const queryReforger = await this.queryReforger;

    let botError = false;

    if (reforgerMessageId && !forceNewMessage) {
      console.log(`old server status message id found ${reforgerMessageId}`);
      try {
        const oldMessage = await serverViewerChannel.messages.fetch(reforgerMessageId);
        const embed = await this.createRichEmbed(queryReforger, this.maintenanceMode);

        const editing = oldMessage.edit({ embeds: [embed] });
        editing
          .then(() => {
            console.log(`server status message edited`);
          })
          .catch((error) => {
            botError = true;
            console.error(`Failed to edit current message, id: ${reforgerMessageId}.`);
            console.error(error);
          });
      } catch (error) {
        console.log(`Error trying to get old server status message `);
        console.error(error);
      }
    } else {
      if (forceNewMessage && reforgerMessageId) {
        console.log(`Deleting old server status message`);
        const message = await serverViewerChannel.messages.fetch(reforgerMessageId);
        await message.delete();
      }

      console.log(`Posting new server status message`);
      const embed = await this.createRichEmbed(queryReforger);
      serverViewerChannel
        .send({ embeds: [embed] })
        .then((newMessage) => {
          Settings.set('reforgerMessageId', newMessage.id);
        })
        .catch((error) => {
          botError = true;
          console.error('Failed to create a new message.');
          console.error(error);
        });
    }

    if (botError) {
      this.setActivity('botError');
    } else {
      if (queryReforger) {
        this.setActivity('ok', queryReforger);
      } else {
        this.setActivity('serverError', queryReforger)
      }
    }
  }

  loopPolling() {
    const timeToWait = process.env.POLLING_INTERVAL_SECONDS;
    setInterval(() => {
      this.startPolling();
    }, parseInt(timeToWait) * 1000);
  }

  private get queryReforger(): Promise<QueryResult | undefined> {
    return new Promise((resolve) => {
      this.reforgerServer
        .queryServer()
        .then((query) => {
          if (query) {
            fs.readFile(process.env.REFORGER_SERVER_ADMIN_STATS_FILE, 'utf-8', function(err, data) {
              if (err) {
                console.log(`Failed to load player list.`);
                throw new Error();
              }
              const obj = JSON.parse(data);
              query.players = Object.values(obj.connected_players).map(p => {
                if (typeof p !== "string") {
                  console.log(`Failed to parse player list.`);
                  throw new Error();
                }
                return {
                  name: p,
                  raw: {
                    time: 0,
                    score: 0
                  }
                }
              })
              query.map = obj.mission;
              resolve(query);
            })
          } else {
            console.log(`Failed to refresh server info.`);
            resolve(undefined);
          }
        })
        .catch((err) => {
          console.log(process.env.REFORGERPORT)
          console.log(parseInt(process.env.REFORGERPORT))
          console.log(err);
          console.log('Server is offline');
          resolve(undefined);
        });
    });
  }

  private getDescriptionRepeater(text: string): string {
    // Repeat the dashes for 62.5% of the text length
    return '─'.repeat(text.length * 0.625);
  }

  private async getReforgerFields(query: QueryResult): Promise<IField[]> {
    const playerListData = ['```py'];
    // Check if the embed doesn't go over the maximum allowed Discord value
    let hasPlayers = true;
    if (
      query.players.length &&
      this.getPlayerListCharacterCount(query.players) < 1024
    ) {
      // Sort alphabetically
      query.players.sort((a, b) =>
        a.name > b.name ? 1 : b.name > a.name ? -1 : 0,
      );
      query.players.forEach((player) => {
        playerListData.push(this.getPlayerDisplayText(player));
      });
    } else if (query.players.length) {
      playerListData.push(locale.tooManyPlayers);
    } else {
      playerListData.push(locale.noPlayers);
      hasPlayers = false;
    }
    if (!hasPlayers) {
      return [
        {
          inline: true,
          name: locale.statuses.status,
          value: locale.statuses.online,
        },
        {
          inline: true,
          name: 'State',
          value: 'No Mission Loaded',
        },
      ];
    } else {
      playerListData.push('```');
      return [
        {
          inline: false,
          name: locale.statuses.status,
          value: locale.statuses.online,
        },
        {
          inline: true,
          name: 'Mission Type',
          value: "Custom",
        },
        {
          inline: true,
          name: locale.mission,
          value: query.map || 'Unknown',
        },
        {
          inline: true,
          name: '\u200b',
          value: '\u200b',
        },
        {
          inline: true,
          name: locale.playerCount,
          value: `${query.players.length}/${query.maxplayers}`,
        },
        {
          inline: true,
          name: '\u200b',
          value: '\u200b',
        },
        {
          inline: false,
          name: locale.playerList,
          value: playerListData.join('\n'),
        },
      ];
    }   
  }

  private async getSuccessFields(query: QueryResult): Promise<IField[]> {
    const playerListData = ['```py'];
    // Check if the embed doesn't go over the maximum allowed Discord value
    let hasPlayers = true;
    if (
      query.players.length &&
      this.getPlayerListCharacterCount(query.players) < 1024
    ) {
      // Sort alphabetically
      query.players.sort((a, b) =>
        a.name > b.name ? 1 : b.name > a.name ? -1 : 0,
      );
      query.players.forEach((player) => {
        playerListData.push(this.getPlayerDisplayText(player));
      });
    } else if (query.players.length) {
      playerListData.push(locale.tooManyPlayers);
    } else {
      playerListData.push(locale.noPlayers);
      hasPlayers = false;
    }
    if (!hasPlayers) {
      return [
        {
          inline: true,
          name: locale.statuses.status,
          value: locale.statuses.online,
        },
        {
          inline: true,
          name: 'State',
          value: 'No Mission Loaded',
        },
      ];
    } else {
      let missionType = 'undefined';
      let typeLength = 2;
      const raw: any = query.raw
      const gameName: string = raw.game;
      if (gameName.substring(0, 5) == 'COTVT') {
        missionType = 'COTVT';
        typeLength = 5;
      } else {
        switch (gameName ? gameName.substring(0, 2) : 'undefined') {
          case 'CO': {
            missionType = 'COOP';
            break;
          }
          case 'TV': {
            missionType = 'TVT';
            typeLength = 3;
            break;
          }
          case 'LO': {
            missionType = 'LOL';
            typeLength = 3;
            break;
          }
          default: {
            missionType = 'undefined';
          }
        }
      }
      //console.log(`gameName:  ${gameName}`);
      //console.log(`missionType:  ${missionType}`);
      let missionName = 'undefined';
      let missionSlots = '64';
      if (missionType !== 'undefined') {
        const missionSlotsSearch = gameName.match(/[A-z]+([0-9]+)/);
        if (missionSlotsSearch && typeLength) {
          missionSlots = missionSlotsSearch[1];
          const missionNameSlice = gameName.slice(
            typeLength + missionSlots.length,
          );
          const missionNameSearch = missionNameSlice.match(/\w+.+/);
          missionName = missionNameSearch
            ? missionNameSearch[0].replace(/_/g, ' ')
            : 'undefined';
          //console.log(`missionSlots:  ${missionSlots}`);
          //console.log(`missionName:  ${missionName}`);
        }
        playerListData.push('```');
        return [
          {
            inline: false,
            name: locale.statuses.status,
            value: locale.statuses.online,
          },
          {
            inline: true,
            name: 'Mission Type',
            value: missionType,
          },
          {
            inline: true,
            name: locale.mission,
            value: missionName,
          },
          {
            inline: true,
            name: '\u200b',
            value: '\u200b',
          },
          {
            inline: true,
            name: locale.playerCount,
            value: `${query.players.length}/${missionSlots}`,
          },
          {
            inline: true,
            name: locale.map,
            value: query.map ? query.map : locale.noMap,
          },
          {
            inline: true,
            name: '\u200b',
            value: '\u200b',
          },
          {
            inline: false,
            name: locale.playerList,
            value: playerListData.join('\n'),
          },
        ];
      } else {
        playerListData.push('```');
        return [
          {
            inline: false,
            name: locale.statuses.status,
            value: locale.statuses.online,
          },
          {
            inline: true,
            name: 'Mission Type',
            value: "Custom",
          },
          {
            inline: true,
            name: locale.mission,
            value: raw.game,
          },
          {
            inline: true,
            name: '\u200b',
            value: '\u200b',
          },
          {
            inline: true,
            name: locale.playerCount,
            value: `${query.players.length}/${query.maxplayers}`,
          },
          {
            inline: true,
            name: locale.map,
            value: query.map ? query.map : locale.noMap,
          },
          {
            inline: true,
            name: '\u200b',
            value: '\u200b',
          },
          {
            inline: false,
            name: locale.playerList,
            value: playerListData.join('\n'),
          },
        ];
      }
    }
  }

  private getMaintenanceFields(): IField[] {
    return [
      {
        inline: false,
        name: locale.statuses.status,
        value: locale.statuses.offline,
      },
      {
        inline: false,
        name: locale.serverDownForMaintenance,
        value: locale.serverDownForMaintenanceDescription,
      },
    ];
  }

  public generatePing(id: string): string {
    return `<@&${id}>`;
  }

  private getErrorFields(): IField[] {
    return [
      {
        inline: false,
        name: locale.statuses.status,
        value: locale.statuses.offline,
      },
      {
        inline: false,
        name: locale.serverDownMessages.serverDownAlternative,
        value:
          `${this.generatePing(process.env.DISCORD_ADMIN_ROLE_ID)}` +
          `${locale.serverDownMessages.pleaseFixServer}`,
      },
    ];
  }

  public async createRichEmbed(query?: QueryResult, maintenanceMode?: boolean) {
    if (query) {
      return new EmbedBuilder({
        color: COLOR_OK,
        // As the ─ is just a little larger than the actual letters, it isn't equal to the letter count
        description: this.getDescriptionRepeater(query.name),
        fields: await this.getReforgerFields(query),
        timestamp: new Date(),
        thumbnail: {
          url: 'https://globalconflicts.net/_next/image?url=%2F_next%2Fstatic%2Fmedia%2Fbanner.8d01371c.png&w=1080&q=100',
        },
        //title: query.name,
        title: locale.armaReforgerServerName,
      });
    } else if (maintenanceMode) {
      return new EmbedBuilder({
        color: COLOR_MAINTENANCE,
        description: locale.serverDownForMaintenance,
        fields: this.getMaintenanceFields(),
        timestamp: new Date(),
        title: locale.serverDownForMaintenance,
      });
    } else {
      return new EmbedBuilder({
        color: COLOR_ERROR,
        description: locale.serverOffline,
        fields: this.getErrorFields(),
        timestamp: new Date(),
        title: locale.serverOffline,
      });
    }
  }

  public async setActivity(
    status: 'ok' | 'serverError' | 'botError' | 'maintenance',
    query?: QueryResult
  ) {
    const _client = await this.discordProvider.getClient();
    if (query && status === 'ok') {
      _client.user.setPresence({
        status: 'online',
        activities: [
          {
            name: `${query.map} (${query.players.length}/${query.maxplayers})`,
            type: ActivityType.Playing
          },
        ],
      });
    } else if (status === 'serverError') {
      _client.user.setPresence({
        status: 'dnd',
        activities: [
          {
            name: locale.presence.error,
            type: ActivityType.Watching
          },
        ],
      });
    } else if (status === 'maintenance') {
      _client.user.setPresence({
        status: 'idle',
        activities: [
          {
            name: locale.presence.maintenance,
            type: ActivityType.Watching
          },
        ],
      });
    } else {
      _client.user.setPresence({
        status: 'idle',
        activities: [
          {
            name: locale.presence.botFailure,
            type: ActivityType.Streaming
          },
        ],
      });
    }
  }
  private getPlayerDisplayText(player: Player): string {
    return `• ${player.name}`;
  }

  private getPlayerListCharacterCount(players: Player[]): number {
    return players
      .map((p) => this.getPlayerDisplayText(p).length)
      .reduce((prev, curr) => prev + curr);
  }
}
