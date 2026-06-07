/* eslint-disable prettier/prettier */
import { DiscordClientProvider, On, Once } from '@discord-nestjs/core';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

import { ActionRowBuilder, ActivityType, EmbedBuilder, Interaction, StringSelectMenuBuilder, TextChannel, ModalBuilder, TextInputBuilder, TextInputStyle, ModalActionRowComponentBuilder, ButtonBuilder, ButtonStyle, GuildMember } from 'discord.js';
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

  @Once('ready')
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
    if (interaction.isAutocomplete() && (interaction.commandName === 'warn' || interaction.commandName === 'ban')) {
      await this.handleAutocomplete(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_search_modal_')) {
      await this.handleUucsSearchModal(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_direct_')) {
      await this.handleUucsDirectModal(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_timeout_modal_')) {
      await this.handleUucsTimeoutModal(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_spammer_ban_modal_')) {
      await this.handleUucsSpammerBanModal(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_')) {
      await this.handleUucsModal(interaction);
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('uucs_rule_select_')) {
      await this.handleUucsRuleSelect(interaction);
      return;
    }

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

  @On('messageReactionAdd')
  async onReactionAdd(reaction: any, user: any): Promise<void> {
    if (user.bot) return;
    
    // Check if this is a UUCS vote message
    const message = reaction.message;
    if (message.embeds.length > 0 && message.embeds[0].title === '🗳️ Ban Vote Initiated') {
      const voteId = message.embeds[0].footer?.text?.replace('Vote ID: ', '');
      if (!voteId) return;

      const emoji = reaction.emoji.name;
      const emojis = ['🇦', '🇧', '🇨', '🇩', '🇪', '🇫'];
      const optionIndex = emojis.indexOf(emoji);

      if (optionIndex !== -1) {
        try {
          const websiteUrl = process.env.WEBSITE_URL;
          await axios.post(
            `${websiteUrl}/api/staff/votes/cast`,
            { voteId, staffDiscordId: user.id, optionIndex },
            { headers: { 'x-api-secret': process.env.API_SECRET } }
          );
          
          // Optional: Remove other reactions from this user to enforce single choice
          const userReactions = message.reactions.cache.filter(r => r.emoji.name !== emoji && r.users.cache.has(user.id));
          for (const ur of userReactions.values()) {
            await ur.users.remove(user.id);
          }
        } catch (error) {
          console.error('Error casting vote:', error);
        }
      }
    }
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

  private getDefaultDuration(rule: any, isWarning: boolean): string {
    if (isWarning) {
      return '0';
    }
    const options = rule?.punishmentOptions || [];
    for (const opt of options) {
      const lower = opt.toLowerCase();
      if (lower.includes('1 week')) return '168';
      if (lower.includes('2 week')) return '336';
      if (lower.includes('3 week')) return '504';
      if (lower.includes('4 week') || lower.includes('1 month')) return '720';
      if (lower.includes('3 month')) return '2160';
      if (lower.includes('6 month')) return '4320';
      if (lower.includes('permanent')) return '0';
    }
    return '168';
  }

  private async handleAutocomplete(interaction: any): Promise<void> {
    const focusedValue = interaction.options.getFocused()?.toLowerCase() || '';

    const query: any = { isActive: true };
    if (focusedValue) {
      query.$or = [
        { ruleId: { $regex: focusedValue, $options: 'i' } },
        { title: { $regex: focusedValue, $options: 'i' } },
        { description: { $regex: focusedValue, $options: 'i' } },
      ];
    }

    const rules = await this.db.collection('rules')
      .find(query)
      .sort({ category: 1, order: 1, ruleId: 1 })
      .limit(25)
      .toArray();

    const choices = rules.map((rule) => {
      let name = `[${rule.ruleId}] ${rule.title}`;
      if (name.length > 100) {
        name = name.substring(0, 97) + '...';
      }
      return {
        name,
        value: rule.ruleId,
      };
    });

    await interaction.respond(choices);
  }

  private async handleUucsSearchModal(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const actionType = parts[3]; // 'warning' or 'ban'
    const targetUserId = parts[4];
    const messageId = parts[5]; // 'none' or messageId

    const searchTerm = interaction.fields.getTextInputValue('search_term')?.trim() || '';

    await interaction.deferReply({ ephemeral: true });

    const query: any = { isActive: true };
    if (searchTerm) {
      query.$or = [
        { ruleId: { $regex: searchTerm, $options: 'i' } },
        { title: { $regex: searchTerm, $options: 'i' } },
        { description: { $regex: searchTerm, $options: 'i' } },
      ];
    }

    const rules = await this.db.collection('rules')
      .find(query)
      .sort({ category: 1, order: 1, ruleId: 1 })
      .limit(25)
      .toArray();

    if (rules.length === 0) {
      await interaction.editReply({
        content: `No rules found matching "${searchTerm}". Please try again.`,
      });
      return;
    }

    const selectMenu = new StringSelectMenuBuilder()
      .setCustomId(`uucs_rule_select_${actionType}_${targetUserId}_${messageId}`)
      .setPlaceholder('Select a rule infraction...');

    const options = rules.map((rule) => {
      let label = `[${rule.ruleId}] ${rule.title}`;
      if (label.length > 100) {
        label = label.substring(0, 97) + '...';
      }
      let description = rule.description || '';
      if (description.length > 100) {
        description = description.substring(0, 97) + '...';
      }
      return {
        label,
        value: rule.ruleId,
        description: description || undefined,
      };
    });

    selectMenu.addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);

    await interaction.editReply({
      content: `Found ${rules.length} rules matching your search. Select the rule below:`,
      components: [row],
    });
  }

  private async handleUucsRuleSelect(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const actionType = parts[3]; // 'warning' or 'ban'
    const targetUserId = parts[4];
    const messageId = parts[5]; // 'none' or messageId

    const ruleId = interaction.values[0];
    const rule = await this.db.collection('rules').findOne({ ruleId });
    const defaultDuration = this.getDefaultDuration(rule, actionType === 'warning');

    const targetUser = await interaction.client.users.fetch(targetUserId).catch(() => null);
    const username = targetUser ? targetUser.username : 'User';

    const modal = new ModalBuilder()
      .setCustomId(
        actionType === 'warning'
          ? `uucs_warning_modal_${targetUserId}_${messageId}_${ruleId}`
          : `uucs_ban_modal_${targetUserId}_${ruleId}`
      )
      .setTitle(`Issue ${actionType === 'warning' ? 'Warning' : 'Ban'}: ${username}`);

    const ruleInput = new TextInputBuilder()
      .setCustomId('rule_id')
      .setLabel('Rule ID')
      .setStyle(TextInputStyle.Short)
      .setValue(ruleId)
      .setRequired(true);

    const reasonInput = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason / Context')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Explain why this infraction is being issued...')
      .setRequired(false);

    const evidenceInput = new TextInputBuilder()
      .setCustomId('evidence_urls')
      .setLabel('Evidence Image URLs (spaced/newlines)')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Paste evidence URLs here...')
      .setRequired(false);

    const rows: ActionRowBuilder<ModalActionRowComponentBuilder>[] = [
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(ruleInput),
      new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(reasonInput),
    ];

    if (actionType === 'warning') {
      const timeoutInput = new TextInputBuilder()
        .setCustomId('timeout_hours')
        .setLabel('Timeout Duration (Hours)')
        .setStyle(TextInputStyle.Short)
        .setValue(defaultDuration)
        .setPlaceholder('Timeout in hours (0 for none)')
        .setRequired(false);

      rows.push(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(timeoutInput));
    } else {
      const durationInput = new TextInputBuilder()
        .setCustomId('duration_hours')
        .setLabel('Ban Duration (Hours)')
        .setStyle(TextInputStyle.Short)
        .setValue(defaultDuration)
        .setPlaceholder('Duration in hours (0 for Life Ban)')
        .setRequired(true);

      const platformInput = new TextInputBuilder()
        .setCustomId('platforms')
        .setLabel('Platforms (ARMA, DISCORD, BOTH)')
        .setStyle(TextInputStyle.Short)
        .setValue('BOTH')
        .setRequired(true);

      rows.push(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(durationInput),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(platformInput)
      );
    }

    rows.push(new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(evidenceInput));

    modal.addComponents(...rows);
    await interaction.showModal(modal);
  }

  private async handleUucsModal(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const isWarning = customId.startsWith('uucs_warning_modal_');
    const parts = customId.split('_');
    const targetUserId = parts[3];
    const messageId = isWarning ? parts[4] : null;

    const ruleId = interaction.fields.fields.get('rule_id')?.value;
    const reason = interaction.fields.fields.get('reason')?.value || '';
    const evidenceInput = interaction.fields.fields.get('evidence_urls')?.value || '';
    const evidenceUrls = evidenceInput
      .split(/[\s,\n]+/)
      .map((url: string) => url.trim())
      .filter((url: string) => url !== '');
    
    // Auto-archive target message attachments
    if (messageId && messageId !== 'none' && interaction.channel) {
      try {
        const targetMsg = await interaction.channel.messages.fetch(messageId).catch(() => null);
        if (targetMsg && targetMsg.attachments.size > 0) {
          targetMsg.attachments.forEach((att: any) => {
            if (att.url && !evidenceUrls.includes(att.url)) {
              evidenceUrls.push(att.url);
            }
          });
        }
      } catch (err) {
        console.error('Failed to fetch target message attachments for auto-evidence:', err);
      }
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      let type = isWarning ? 'WARNING' : 'BAN';
      let durationMinutes = null;
      let platforms = ['ARMA', 'DISCORD'];

      if (!isWarning) {
        const durationHoursInput = interaction.fields.fields.get('duration_hours')?.value || '0';
        const durationHours = parseInt(durationHoursInput);
        durationMinutes = durationHours * 60;

        const member = interaction.member as GuildMember;
        const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
        const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
        const isGMOnly = member && member.roles.cache.has(gmRoleId) && !member.roles.cache.has(adminRoleId);
        if (isGMOnly) {
          if (durationHours === 0 || durationHours > 24) {
            await interaction.editReply({ content: 'Game Masters are only authorized to issue temporary bans up to 24 hours.' });
            return;
          }
        }

        if (durationHours === 0) type = 'LIFE_BAN';
        
        const platformsInput = interaction.fields.fields.get('platforms')?.value?.toUpperCase();
        if (platformsInput === 'ARMA') platforms = ['ARMA'];
        else if (platformsInput === 'DISCORD') platforms = ['DISCORD'];
      } else {
        const timeoutHoursInput = interaction.fields.fields.get('timeout_hours')?.value || '0';
        const timeoutHours = parseInt(timeoutHoursInput);
        durationMinutes = timeoutHours * 60;
      }

      const websiteUrl = process.env.WEBSITE_URL;
      const discordContext = await this.fetchDiscordContext(interaction.channel, messageId);
      const response = await axios.post(
        `${websiteUrl}/api/staff/infractions`,
        {
          targetDiscordId: targetUserId,
          staffDiscordId: interaction.user.id,
          type,
          ruleId,
          reason,
          durationMinutes,
          platforms,
          evidenceUrls,
          messageUrl: messageId && messageId !== 'none' ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${messageId}` : null,
          discordContext,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        }
      );

      if (response.data.ok) {
        // Apply Discord action if needed (e.g. timeout or ban)
        const guild = interaction.guild;
        const targetMember = await guild.members.fetch(targetUserId).catch(() => null);

        if (type === 'WARNING' && durationMinutes > 0 && targetMember) {
          await targetMember.timeout(durationMinutes * 60 * 1000, reason);
        } else if (type === 'BAN' && targetMember) {
          if (durationMinutes && durationMinutes <= 1440) {
            // Temporary Game Ban: Do not ban from Discord guild. Role applied via notifyInfraction.
          } else {
            await targetMember.ban({ reason });
          }
        } else if (type === 'LIFE_BAN' && targetMember) {
           await targetMember.ban({ reason: `LIFE BAN: ${reason}` });
        }

        await interaction.editReply({ content: `Successfully issued ${type} for <@${targetUserId}>.` });
      } else {
        await interaction.editReply({ content: `Failed to issue infraction: ${response.data.error}` });
      }
    } catch (error: any) {
      console.error('UUCS Modal Error:', error);
      await interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
  }

  private async fetchDiscordContext(channel: any, messageId: string | null): Promise<any> {
    if (!messageId || messageId === 'none' || !channel) return null;
    try {
      const targetMsg = await channel.messages.fetch(messageId);
      if (targetMsg) {
        const contextMessagesCollection = await channel.messages.fetch({
          limit: 9,
          before: messageId,
        });
        const contextMsgs = contextMessagesCollection
          ? Array.from(contextMessagesCollection.values())
              .reverse()
              .map((msg: any) => ({
                author: msg.author.tag,
                authorId: msg.author.id,
                content: msg.content || '',
                timestamp: msg.createdAt.toISOString(),
              }))
          : [];

        return {
          targetMessage: {
            author: targetMsg.author.tag,
            authorId: targetMsg.author.id,
            content: targetMsg.content || '',
            timestamp: targetMsg.createdAt.toISOString(),
          },
          contextMessages: contextMsgs,
        };
      }
    } catch (err) {
      console.error('Failed to fetch Discord message context:', err);
    }
    return null;
  }

  private async handleUucsDirectModal(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const isWarning = customId.startsWith('uucs_direct_warning_modal_');
    const parts = customId.split('_');
    const messageId = isWarning ? parts[4] : null;

    await interaction.deferReply({ ephemeral: true });

    try {
      const selectedUsers = interaction.fields.getSelectedUsers('target_user');
      const targetUserId = selectedUsers?.first()?.id;

      if (!targetUserId) {
        await interaction.editReply({ content: 'No target user was selected.' });
        return;
      }

      const ruleValues = interaction.fields.getStringSelectValues('rule_id');
      const ruleId = ruleValues?.[0];
      if (!ruleId) {
        await interaction.editReply({ content: 'No infraction rule was selected.' });
        return;
      }

      const reason = interaction.fields.getTextInputValue('reason') || '';

      let type = isWarning ? 'WARNING' : 'BAN';
      let durationMinutes = 0;
      const platforms = ['ARMA', 'DISCORD'];

      if (isWarning) {
        const timeoutHoursInput = interaction.fields.getTextInputValue('timeout_hours') || '0';
        const timeoutHours = parseInt(timeoutHoursInput);
        durationMinutes = timeoutHours * 60;
      } else {
        const durationHoursInput = interaction.fields.getTextInputValue('duration_hours') || '0';
        const durationHours = parseInt(durationHoursInput);
        durationMinutes = durationHours * 60;

        const member = interaction.member as GuildMember;
        const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
        const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
        const isGMOnly = member && member.roles.cache.has(gmRoleId) && !member.roles.cache.has(adminRoleId);
        if (isGMOnly) {
          if (durationHours === 0 || durationHours > 24) {
            await interaction.editReply({ content: 'Game Masters are only authorized to issue temporary bans up to 24 hours.' });
            return;
          }
        }

        if (durationHours === 0) {
          type = 'LIFE_BAN';
        }
      }

      // Extract uploaded evidence attachments using the new getUploadedFiles helper
      const uploadedFiles = interaction.fields.getUploadedFiles('evidence_files');
      const evidenceUrls = uploadedFiles
        ? Array.from(uploadedFiles.values()).map((file: any) => file.url)
        : [];

      // Auto-archive target message attachments
      if (messageId && messageId !== 'none' && interaction.channel) {
        try {
          const targetMsg = await interaction.channel.messages.fetch(messageId).catch(() => null);
          if (targetMsg && targetMsg.attachments.size > 0) {
            targetMsg.attachments.forEach((att: any) => {
              if (att.url && !evidenceUrls.includes(att.url)) {
                evidenceUrls.push(att.url);
              }
            });
          }
        } catch (err) {
          console.error('Failed to fetch target message attachments for auto-evidence:', err);
        }
      }

      const websiteUrl = process.env.WEBSITE_URL;
      const discordContext = await this.fetchDiscordContext(interaction.channel, messageId);
      const response = await axios.post(
        `${websiteUrl}/api/staff/infractions`,
        {
          targetDiscordId: targetUserId,
          staffDiscordId: interaction.user.id,
          type,
          ruleId,
          reason,
          durationMinutes,
          platforms,
          evidenceUrls,
          messageUrl: messageId && messageId !== 'none' ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${messageId}` : null,
          discordContext,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        }
      );

      if (response.data.ok) {
        // Apply Discord action if needed (e.g. timeout or ban)
        const guild = interaction.guild;
        const targetMember = await guild.members.fetch(targetUserId).catch(() => null);

        if (type === 'WARNING' && durationMinutes > 0 && targetMember) {
          await targetMember.timeout(durationMinutes * 60 * 1000, reason);
        } else if ((type === 'BAN' || type === 'LIFE_BAN') && targetMember) {
          if (type === 'BAN' && durationMinutes && durationMinutes <= 1440) {
            // Temporary Game Ban: Do not ban from Discord guild. Role applied via notifyInfraction.
          } else {
            await targetMember.ban({ reason: type === 'LIFE_BAN' ? `LIFE BAN: ${reason}` : reason });
          }
        }

        await interaction.editReply({ content: `Successfully issued ${type} for <@${targetUserId}>.` });
      } else {
        await interaction.editReply({ content: `Failed to issue infraction: ${response.data.error}` });
      }
    } catch (error: any) {
      console.error('UUCS Direct Modal Error:', error);
      await interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
  }

  private async handleUucsTimeoutModal(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const targetUserId = parts[3];
    const messageId = parts[4] || 'none';

    await interaction.deferReply({ ephemeral: true });

    try {
      const durationVal = interaction.fields.getStringSelectValues('duration_minutes')?.[0] || '5';
      const durationMinutes = parseInt(durationVal);
      const reason = interaction.fields.getTextInputValue('reason') || '';
      const privateReason = interaction.fields.getTextInputValue('private_reason') || '';

      const websiteUrl = process.env.WEBSITE_URL;
      const response = await axios.post(
        `${websiteUrl}/api/staff/infractions`,
        {
          targetDiscordId: targetUserId,
          staffDiscordId: interaction.user.id,
          type: 'TIMEOUT',
          ruleId: 'TIMEOUT',
          reason,
          privateReason,
          durationMinutes,
          platforms: ['DISCORD'],
          messageUrl: messageId && messageId !== 'none' ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${messageId}` : null,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        }
      );

      if (response.data.ok) {
        await interaction.editReply({ content: `Successfully timed out <@${targetUserId}> for ${durationMinutes} minutes.` });
      } else {
        await interaction.editReply({ content: `Failed to issue timeout: ${response.data.error}` });
      }
    } catch (error: any) {
      console.error('UUCS Timeout Modal Error:', error);
      await interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
  }

  private async handleUucsSpammerBanModal(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const parts = customId.split('_');
    const targetUserId = parts[4];
    const messageId = parts[5] || 'none';

    await interaction.deferReply({ ephemeral: true });

    try {
      const confirmVal = interaction.fields.getTextInputValue('confirm')?.trim();
      if (confirmVal?.toUpperCase() !== 'CONFIRM') {
        await interaction.editReply({ content: 'Action aborted. You must type "CONFIRM" to proceed.' });
        return;
      }

      const reason = interaction.fields.getTextInputValue('reason') || '';

      const websiteUrl = process.env.WEBSITE_URL;
      const response = await axios.post(
        `${websiteUrl}/api/staff/infractions`,
        {
          targetDiscordId: targetUserId,
          staffDiscordId: interaction.user.id,
          type: 'SPAMMER_BAN',
          ruleId: 'SPAM',
          reason,
          platforms: ['DISCORD'],
          durationMinutes: null,
          messageUrl: messageId && messageId !== 'none' ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${messageId}` : null,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        }
      );

      if (response.data.ok) {
        await interaction.editReply({ content: `Successfully issued Spammer Ban for <@${targetUserId}>.` });
      } else {
        await interaction.editReply({ content: `Failed to issue spammer ban: ${response.data.error}` });
      }
    } catch (error: any) {
      console.error('UUCS Spammer Ban Modal Error:', error);
      await interaction.editReply({ content: `An error occurred: ${error.message}` });
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async checkExpiredTimeouts(): Promise<void> {
    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return;

    try {
      const config = await this.db.collection('configs').findOne({});
      const timeoutRoleId = config?.timeoutRoleId || '1513121726668607649';
      
      const expiredTimeouts = await this.db.collection('infractions').find({
        type: 'TIMEOUT',
        isVoided: { $ne: true },
        timeoutRoleRemoved: { $ne: true },
      }).toArray();

      const now = new Date();

      for (const inf of expiredTimeouts) {
        const timestamp = new Date(inf.timestamp);
        const expiresAt = new Date(timestamp.getTime() + inf.durationMinutes * 60000);

        if (expiresAt <= now) {
          const targetMember = await guild.members.fetch(inf.targetDiscordId).catch(() => null);
          if (targetMember) {
            if (targetMember.roles.cache.has(timeoutRoleId)) {
              await targetMember.roles.remove(timeoutRoleId).catch((err) => {
                this.logger.error(`Failed to remove timeout role from ${targetMember.user.tag}: ${err.message}`);
              });
              this.logger.log(`Automatically removed expired timeout role from ${targetMember.user.tag}`);
            }
          }
          
          await this.db.collection('infractions').updateOne(
            { _id: inf._id },
            { $set: { timeoutRoleRemoved: true, timeoutRoleRemovedAt: new Date() } }
          );
        }
      }
    } catch (error: any) {
      this.logger.error(`Error checking expired timeouts: ${error.message}`);
    }
  }
}
