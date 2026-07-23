/* eslint-disable prettier/prettier */
import { DiscordClientProvider, On, Once } from '@discord-nestjs/core';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import axios from 'axios';

import { ActionRowBuilder, ActivityType, EmbedBuilder, Interaction, StringSelectMenuBuilder, TextChannel, ModalBuilder, TextInputBuilder, TextInputStyle, ModalActionRowComponentBuilder, ButtonBuilder, ButtonStyle, GuildMember, ChannelType } from 'discord.js';
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

    if (interaction.isButton() && interaction.customId && interaction.customId.startsWith('uucs_ticket_btn_')) {
      await this.handleTicketBtnClick(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_ticket_modal_submit_')) {
      await this.handleTicketModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId && interaction.customId.startsWith('uucs_ticket_staff_reply_')) {
      await this.handleTicketStaffReplyBtnClick(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_ticket_staff_reply_modal_submit_')) {
      await this.handleTicketStaffReplyModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId && interaction.customId.startsWith('uucs_ticket_close_')) {
      await this.handleTicketCloseBtnClick(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId === 'uucs_appeal_btn') {
      await this.handleAppealBtnClick(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === 'uucs_appeal_modal_submit') {
      await this.handleAppealModalSubmit(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId && interaction.customId.startsWith('uucs_appeal_infraction_')) {
      await this.handleAppealInfractionSelect(interaction);
      return;
    }

    if (interaction.isButton() && interaction.customId && interaction.customId.startsWith('uucs_appeal_link_btn_')) {
      await this.handleAppealLinkAccount(interaction);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId.startsWith('uucs_appeal_link_modal_')) {
      await this.handleAppealLinkModalSubmit(interaction);
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
    const focusedOption = interaction.options.getFocused(true);
    const focusedName = focusedOption.name;
    const focusedValue = focusedOption.value?.toLowerCase() || '';

    if (focusedName === 'rule') {
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
    } else if (focusedName === 'duration') {
      const ruleId = interaction.options.getString('rule');
      let choices: string[] = [];

      if (ruleId) {
        const ruleDoc = await this.db.collection('rules').findOne({ ruleId });
        if (ruleDoc && ruleDoc.punishmentOptions && Array.isArray(ruleDoc.punishmentOptions)) {
          choices = ruleDoc.punishmentOptions
            .filter((opt: string) => opt.toLowerCase().trim() !== 'warning')
            .map((opt: string) => {
              const lower = opt.toLowerCase().trim();
              if (
                lower === 'life_ban' ||
                lower === 'life ban' ||
                lower === 'permanent' ||
                lower === 'permanent ban' ||
                lower === 'life_blacklist'
              ) {
                return 'perm Ban';
              }
              return opt;
            });
        }
      }

      if (choices.length === 0) {
        choices = ['perm Ban', '24 Hours', '1 Week', '2 Weeks', '1 Month', '3 Months', '6 Months'];
      }

      choices = Array.from(new Set(choices));

      const filtered = choices.filter((choice) =>
        choice.toLowerCase().includes(focusedValue)
      );

      await interaction.respond(
        filtered.slice(0, 25).map((choice) => ({ name: choice, value: choice }))
      );
    }
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



  private async handleTicketBtnClick(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const type = customId.replace('uucs_ticket_btn_', '').toUpperCase(); // 'GM', 'DM', 'AD'
    const clicker = interaction.user;

    // Check blocks
    const profile = await this.db.collection('user_profiles').findOne({ discordId: clicker.id });
    const blocks = profile?.status?.ticketBlocks;
    const isBlocked = 
      (type === 'GM' && blocks?.isGMBlocked) ||
      (type === 'DM' && blocks?.isDMBlocked) ||
      (type === 'AD' && blocks?.isADBlocked);

    if (isBlocked) {
      await interaction.reply({
        content: `❌ You have been blocked from opening new ${type} tickets. Please contact staff if you believe this is in error.`,
        ephemeral: true,
      });
      return;
    }

    // Check open ticket limits
    const limit = type === 'AD' ? 1 : 3;
    const activeCount = await this.db.collection('tickets').countDocuments({
      userId: clicker.id,
      type: type,
      status: 'OPEN',
    });

    if (activeCount >= limit) {
      await interaction.reply({
        content: `❌ You already have ${activeCount} open ${type} ticket(s) (limit: ${limit}). Please wait until your open tickets are resolved before opening another.`,
        ephemeral: true,
      });
      return;
    }

    // Show modal
    const modal = new ModalBuilder()
      .setCustomId(`uucs_ticket_modal_submit_${type}`)
      .setTitle(`Contact ${type === 'AD' ? 'Admins' : type === 'GM' ? 'Game Masters' : 'Discord Moderators'}`);

    const nameInput = new TextInputBuilder()
      .setCustomId('arma_username')
      .setLabel('Arma / Discord username as seen on server')
      .setStyle(TextInputStyle.Short)
      .setValue(interaction.member?.displayName || clicker.username)
      .setRequired(true);

    const descInput = new TextInputBuilder()
      .setCustomId('description')
      .setLabel('What do you need help with?')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Please be as descriptive as possible')
      .setRequired(true);

    const row1 = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(nameInput);
    const row2 = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(descInput);

    modal.addComponents(row1, row2);
    await interaction.showModal(modal);
  }

  private async handleTicketModalSubmit(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const type = customId.replace('uucs_ticket_modal_submit_', '').toUpperCase(); // 'GM', 'DM', 'AD'
    const clicker = interaction.user;
    const armaUsername = interaction.fields.getTextInputValue('arma_username');
    const description = interaction.fields.getTextInputValue('description');

    await interaction.deferReply({ ephemeral: true });

    try {
      // 1. Generate sequential ID
      const count = await this.db.collection('tickets').countDocuments({ type: type });
      const nextId = String(count + 1).padStart(4, '0');
      const ticketId = `${type}-${nextId}`;

      // 2. Create private thread in the configured ticket panel channel
      const guild = interaction.guild;
      const config = await this.db.collection('configs').findOne({});
      const targetChannelId = config?.ticketPanelChannelId || '1508148256625131590';
      const parentChannel = guild.channels.cache.get(targetChannelId) as TextChannel;
      if (!parentChannel) {
        await interaction.editReply({ content: '❌ Tickets channel not found. Please contact an Administrator.' });
        return;
      }

      const prefixMap: Record<string, string> = { GM: 'GM', DM: 'DM', AD: 'AD' };
      const threadPrefix = prefixMap[type] || type;
      const threadName = `${threadPrefix}-${nextId}-${clicker.username}`;

      const thread = await parentChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 1440,
        type: ChannelType.PrivateThread,
        reason: `Ticket ${ticketId} opened by ${clicker.username}`,
      }).catch(async (err) => {
        console.error("Private thread creation failed, falling back to public thread:", err);
        return await parentChannel.threads.create({
          name: threadName,
          autoArchiveDuration: 1440,
          reason: `Ticket ${ticketId} opened by ${clicker.username}`,
        });
      });

      await thread.members.add(clicker.id).catch(() => null);

      const roleMap: Record<string, string> = {
        GM: process.env.DISCORD_REFORGERGM_ROLE_ID || '',
        DM: process.env.DISCORD_MOD_ROLE_ID || '',
        AD: process.env.DISCORD_ADMIN_ROLE_ID || ''
      };
      const roleId = roleMap[type];
      const rolePing = roleId ? `<@&${roleId}>` : `@${type}`;

      // 3. Post first message inside thread
      const embed = new EmbedBuilder()
        .setTitle(`🎫 Ticket Opened: ${ticketId}`)
        .setDescription(
          `**User:** <@${clicker.id}> (${clicker.tag})\n` +
          `**Arma Username:** ${armaUsername}\n\n` +
          `**Issue:**\n${description}`
        )
        .setColor('#2ea8ff')
        .setTimestamp();

      if (type === 'GM') {
        embed.setFooter({
          text: 'If you are currently IN GAME and playing with us, do not use this option if you need immediate help. Instead write in the game chat.'
        });
      }

      const replyBtn = new ButtonBuilder()
        .setCustomId(`uucs_ticket_staff_reply_${ticketId}`)
        .setLabel('Staff Reply')
        .setEmoji('🛡️')
        .setStyle(ButtonStyle.Primary);

      const closeBtn = new ButtonBuilder()
        .setCustomId(`uucs_ticket_close_${ticketId}`)
        .setLabel('Close Ticket')
        .setEmoji('🔒')
        .setStyle(ButtonStyle.Danger);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(replyBtn, closeBtn);

      await thread.send({
        content: `Welcome <@${clicker.id}>! Staff (${rolePing}) will assist you shortly.`,
        embeds: [embed],
        components: [row]
      });

      // 4. Post ticket info to Next.js API
      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
      await axios.post(
        `${websiteUrl}/api/staff/tickets`,
        {
          ticketId,
          userId: clicker.id,
          type,
          threadId: thread.id,
          modalFields: { armaUsername, description }
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
          timeout: 10000
        }
      );

      await interaction.editReply({
        content: `✅ Ticket opened! A private thread has been created for you: <#${thread.id}>`,
      });
    } catch (err: any) {
      console.error('Error handling ticket submission:', err);
      await interaction.editReply({
        content: `❌ An error occurred: ${err.message}`,
      });
    }
  }

  private async handleTicketStaffReplyBtnClick(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const ticketId = customId.replace('uucs_ticket_staff_reply_', '');
    const member = interaction.member as GuildMember;

    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    
    const isStaff = member && (
      member.roles.cache.has(adminRoleId) ||
      member.roles.cache.has(gmRoleId) ||
      member.roles.cache.some(r => r.name.toLowerCase().includes('moderator') || r.name.toLowerCase().includes('staff') || r.name.toLowerCase().includes('review'))
    );

    if (!isStaff) {
      await interaction.reply({
        content: '❌ Only staff members are authorized to reply to tickets.',
        ephemeral: true,
      });
      return;
    }

    const modal = new ModalBuilder()
      .setCustomId(`uucs_ticket_staff_reply_modal_submit_${ticketId}`)
      .setTitle(`Reply to Ticket: ${ticketId}`);

    const replyInput = new TextInputBuilder()
      .setCustomId('staff_reply_message')
      .setLabel('Staff Message')
      .setStyle(TextInputStyle.Paragraph)
      .setPlaceholder('Type your response here... (Posted anonymously as Staff)')
      .setRequired(true);

    const row = new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(replyInput);
    modal.addComponents(row);

    await interaction.showModal(modal);
  }

  private async handleTicketStaffReplyModalSubmit(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const ticketId = customId.replace('uucs_ticket_staff_reply_modal_submit_', '');
    const clicker = interaction.user;
    const message = interaction.fields.getTextInputValue('staff_reply_message');

    await interaction.deferReply({ ephemeral: true });

    try {
      const channel = interaction.channel;
      if (!channel || !channel.isThread()) {
        await interaction.editReply({ content: '❌ This action can only be performed inside a thread.' });
        return;
      }

      await channel.send({
        content: `**Staff:** ${message}`
      });

      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
      const bestName = interaction.member?.displayName || clicker.username;
      await axios.post(
        `${websiteUrl}/api/staff/tickets/reply`,
        {
          ticketId,
          authorDiscordId: clicker.id,
          authorName: bestName,
          content: message,
          isStaff: true,
          isAnonymous: true
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
          timeout: 10000
        }
      );

      await interaction.editReply({ content: '✅ Reply sent successfully.' });
    } catch (err: any) {
      console.error('Error sending staff reply:', err);
      await interaction.editReply({ content: `❌ Error: ${err.message}` });
    }
  }

  private async handleTicketCloseBtnClick(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const ticketId = customId.replace('uucs_ticket_close_', '');
    const clicker = interaction.user;
    const member = interaction.member as GuildMember;

    await interaction.deferReply({ ephemeral: true });

    try {
      const ticket = await this.db.collection('tickets').findOne({ ticketId: ticketId });
      if (!ticket) {
        await interaction.editReply({ content: '❌ Ticket not found in UUCS database.' });
        return;
      }

      const isOpener = clicker.id === ticket.userId;
      const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
      const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
      const isStaff = member && (
        member.roles.cache.has(adminRoleId) ||
        member.roles.cache.has(gmRoleId) ||
        member.roles.cache.some(r => r.name.toLowerCase().includes('moderator') || r.name.toLowerCase().includes('staff'))
      );

      if (!isOpener && !isStaff) {
        await interaction.editReply({ content: '❌ You do not have permission to close this ticket.' });
        return;
      }

      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
      const bestName = member?.displayName || clicker.username;
      
      await axios.post(
        `${websiteUrl}/api/staff/tickets/resolve`,
        {
          ticketId: ticket._id.toString(),
          resolvedBy: clicker.id,
          resolvedByName: bestName
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
          timeout: 10000
        }
      );

      await interaction.editReply({ content: '✅ Ticket closed successfully.' });
    } catch (err: any) {
      console.error('Error closing ticket:', err);
      await interaction.editReply({ content: `❌ Error: ${err.message}` });
    }
  }

  private getActiveBan(infractions: any[]): any | null {
    const now = Date.now();
    return infractions.find((inf: any) => {
      if (inf.isVoided || inf.isIgnored) return false;
      if (!['BAN', 'LIFE_BAN', 'BLACKLIST'].includes(inf.type)) return false;
      if (inf.type === 'LIFE_BAN' || inf.type === 'BLACKLIST') return true;
      if (!inf.durationMinutes) return false;
      return new Date(inf.timestamp).getTime() + inf.durationMinutes * 60000 > now;
    }) ?? null;
  }

  private async handleAppealBtnClick(interaction: any): Promise<void> {
    const clicker = interaction.user;

    try {
      // Already has a pending appeal with a thread
      const existingPending = await this.db.collection('infractions').findOne({
        targetDiscordId: clicker.id,
        appealStatus: 'PENDING',
        appealThreadId: { $exists: true, $ne: null },
      });

      if (existingPending) {
        const threadLink = existingPending.appealThreadUrl
          ? `\n<${existingPending.appealThreadUrl}>`
          : existingPending.appealThreadId ? ` in thread <#${existingPending.appealThreadId}>` : '';
        await interaction.reply({
          content: `⚠️ You already have a pending appeal. Please wait for staff to review it before opening a new one.${threadLink}`,
          ephemeral: true,
        });
        return;
      }

      const config = await this.db.collection('configs').findOne({});
      const cooldownDays: number = config?.appealCooldownDays ?? 90;
      const cooldownMs = cooldownDays * 86400000;

      // Check if this Discord user has a linked UUCS profile
      const uucsUser = await this.db.collection('users').findOne({ discordId: clicker.id });
      const isLinkedToUucs = !!uucsUser;

      const allInfractions = await this.db.collection('infractions').find({
        targetDiscordId: clicker.id,
        isVoided: { $ne: true },
        isIgnored: { $ne: true },
      }).sort({ timestamp: -1 }).toArray();

      const activeBan = this.getActiveBan(allInfractions);

      if (activeBan) {
        // Check denial cooldown — only applies when user has an active ban
        const recentlyDenied = allInfractions.find((inf: any) =>
          inf.appealStatus === 'DENIED' &&
          inf.appealUpdatedAt &&
          new Date(inf.appealUpdatedAt).getTime() > Date.now() - cooldownMs
        );

        if (recentlyDenied) {
          const cooldownEnd = new Date(new Date(recentlyDenied.appealUpdatedAt).getTime() + cooldownMs);
          const fmt = (d: Date) => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });

          let banExpiresAt: Date | null = null;
          if (activeBan.durationMinutes) {
            banExpiresAt = new Date(new Date(activeBan.timestamp).getTime() + activeBan.durationMinutes * 60000);
          }

          const unlockMsg = banExpiresAt && banExpiresAt < cooldownEnd
            ? `Your ban expires on **${fmt(banExpiresAt)}**, at which point you may reappeal.`
            : `You may reappeal after **${fmt(cooldownEnd)}** (${cooldownDays}-day cooldown).`;

          await interaction.reply({
            content: `⏳ Your previous appeal was denied. ${unlockMsg}`,
            ephemeral: true,
          });
          return;
        }
      }

      // For linked UUCS users, check there is at least one appealable infraction
      if (isLinkedToUucs && allInfractions.length > 0) {
        const hasAppealable = allInfractions.some(
          (inf: any) => !inf.appealStatus || inf.appealStatus === 'NONE'
        );
        if (!hasAppealable) {
          await interaction.reply({
            content: `ℹ️ All your infractions have already been reviewed or appealed.`,
            ephemeral: true,
          });
          return;
        }
      }

      // Unlinked users (not in UUCS) are allowed through — staff will investigate
      const modal = new ModalBuilder()
        .setCustomId('uucs_appeal_modal_submit')
        .setTitle('Submit an Appeal');

      const armaNameInput = new TextInputBuilder()
        .setCustomId('arma_username')
        .setLabel('Arma username (if different from Discord)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Leave blank if same as your Discord username')
        .setRequired(false);

      const messageInput = new TextInputBuilder()
        .setCustomId('appeal_message')
        .setLabel('Your appeal statement')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Explain your situation and include any relevant context or evidence.')
        .setRequired(true)
        .setMaxLength(1500);

      modal.addComponents(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(armaNameInput),
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(messageInput),
      );
      await interaction.showModal(modal);
    } catch (err: any) {
      console.error('Error handling appeal button click:', err);
      try {
        await interaction.reply({ content: `❌ An error occurred: ${err.message}`, ephemeral: true });
      } catch (_) { /* interaction may already be replied to */ }
    }
  }

  private async handleAppealModalSubmit(interaction: any): Promise<void> {
    const clicker = interaction.user;
    const armaUsername = interaction.fields.getTextInputValue('arma_username')?.trim() || null;
    const appealMessage = interaction.fields.getTextInputValue('appeal_message');

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      const config = await this.db.collection('configs').findOne({});
      const targetChannelId = config?.ticketPanelChannelId || '1508148256625131590';
      const parentChannel = guild.channels.cache.get(targetChannelId) as TextChannel;

      if (!parentChannel) {
        await interaction.editReply({ content: '❌ Appeals channel not found. Please contact an Administrator.' });
        return;
      }

      // Check if this Discord user has a linked UUCS profile
      const uucsUser = await this.db.collection('users').findOne({ discordId: clicker.id });
      const isLinkedToUucs = !!uucsUser;

      // All non-voided, non-ignored infractions for this Discord user
      const allInfractions = await this.db.collection('infractions').find({
        targetDiscordId: clicker.id,
        isVoided: { $ne: true },
        isIgnored: { $ne: true },
      }).sort({ timestamp: -1 }).toArray();

      const activeBan = this.getActiveBan(allInfractions);

      // Create private thread
      const threadName = `APPEAL-${clicker.username}`;
      const thread = await parentChannel.threads.create({
        name: threadName,
        autoArchiveDuration: 10080,
        type: ChannelType.PrivateThread,
        reason: `Appeal opened by ${clicker.username}`,
      }).catch(async (err) => {
        console.error('Private thread creation failed, falling back to public:', err);
        return parentChannel.threads.create({
          name: threadName,
          autoArchiveDuration: 10080,
          reason: `Appeal opened by ${clicker.username}`,
        });
      });

      await thread.members.add(clicker.id).catch(() => null);

      const modRoleId = config?.appealModRoleId || process.env.DISCORD_MOD_ROLE_ID || '';
      const gmRoleId = config?.appealGmRoleId || process.env.DISCORD_REFORGERGM_ROLE_ID || '';
      const adminRoleId = config?.appealAdminRoleId || process.env.DISCORD_ADMIN_ROLE_ID || '';
      const notifyMode: string = config?.appealNotifyRoles ?? 'both';
      const staffParts: string[] = [];
      if (notifyMode === 'both' || notifyMode === 'staff_only') {
        if (modRoleId) staffParts.push(`<@&${modRoleId}>`);
        if (gmRoleId) staffParts.push(`<@&${gmRoleId}>`);
      }
      if (notifyMode === 'both' || notifyMode === 'admins_only') {
        if (adminRoleId) staffParts.push(`<@&${adminRoleId}>`);
      }
      const staffPing = staffParts.join(' ');
      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
      const threadUrl = `https://discord.com/channels/${guild.id}/${thread.id}`;

      const fmtDate = (d: any) => d
        ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
        : '?';

      const fmtInfraction = (inf: any, highlight = false): string => {
        const date = fmtDate(inf.timestamp);
        const duration = inf.durationMinutes
          ? `${inf.durationMinutes / 60}h`
          : (inf.type === 'LIFE_BAN' || inf.type === 'BLACKLIST' ? 'Permanent' : '–');
        const rule = inf.ruleId || 'No rule';
        const statusTag = inf.appealStatus && inf.appealStatus !== 'NONE' ? ` [${inf.appealStatus}]` : '';
        if (highlight) return `🔴 **${inf.type} — ${rule} | ${date} | ${duration}** ← appealing`;
        return `${inf.type} — ${rule} | ${date} | ${duration}${statusTag}`;
      };

      const websiteUserUrl = `${websiteUrl}/dashboard/staff/users?q=${clicker.id}`;

      // ── Case 1: Unlinked user — no UUCS profile found ──
      if (!isLinkedToUucs) {
        const embed = new EmbedBuilder()
          .setTitle(`📋 Appeal: ${clicker.username}`)
          .setDescription(
            `**User:** <@${clicker.id}>` +
            (armaUsername ? ` | **Arma name:** ${armaUsername}` : '') +
            `\n\n**Statement:**\n${appealMessage}` +
            `\n\n⚠️ **This Discord account has no linked UUCS profile.**\nStaff must verify the user's identity and link their account before this appeal can be processed.`
          )
          .setColor('#e67e22')
          .setTimestamp();

        const linkBtn = new ButtonBuilder()
          .setCustomId(`uucs_appeal_link_btn_${clicker.id}`)
          .setLabel('🔗 Link to UUCS Profile')
          .setStyle(ButtonStyle.Secondary);

        await thread.send({
          content: `<@${clicker.id}>\n${staffPing} — new appeal from **unlinked** user.`,
          embeds: [embed],
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkBtn)],
        });

        await interaction.editReply({
          content: `✅ Appeal thread created: <#${thread.id}>\n\nStaff will contact you to verify your identity.`,
        });
        return;
      }

      // ── Case 2: Active ban — auto-target it ──
      if (activeBan) {
        // Look up rule details for the active ban
        const ruleDoc = await this.db.collection('rules').findOne({ ruleId: activeBan.ruleId });
        const ruleTitle = ruleDoc?.title || activeBan.ruleId || 'Unknown Rule';

        const banDate = fmtDate(activeBan.timestamp);
        const banDuration = activeBan.type === 'LIFE_BAN' || activeBan.type === 'BLACKLIST'
          ? 'Permanent'
          : activeBan.durationMinutes
            ? `${Math.round(activeBan.durationMinutes / 60 / 24)} day(s)`
            : '–';

        let banExpiryLine = '';
        if (activeBan.durationMinutes && activeBan.type === 'BAN') {
          const expiryDate = new Date(new Date(activeBan.timestamp).getTime() + activeBan.durationMinutes * 60000);
          banExpiryLine = `\n**Expires:** ${fmtDate(expiryDate)}`;
        }

        const banNotesLine = activeBan.notes ? `\n**Reason:** ${activeBan.notes}` : '';
        const banIssuedLine = activeBan.issuedByNickname ? `\n**Issued by:** ${activeBan.issuedByNickname}` : '';

        const infractionLines = allInfractions.map((inf: any) =>
          fmtInfraction(inf, inf._id.toString() === activeBan._id.toString())
        ).join('\n');

        const infractionId = activeBan._id.toString();
        const appealsUrl = `${websiteUrl}/dashboard?openAppeal=${infractionId}`;

        const embed = new EmbedBuilder()
          .setTitle(`📋 Appeal: ${clicker.username}`)
          .setDescription(
            `**User:** <@${clicker.id}>` +
            (armaUsername ? ` | **Arma name:** ${armaUsername}` : '') +
            `\n\n**Statement:**\n${appealMessage}` +
            `\n\n**Active Ban Details:**` +
            `\n**Rule:** ${ruleTitle} (${activeBan.ruleId ?? '–'})` +
            `\n**Type:** ${activeBan.type} | **Issued:** ${banDate} | **Duration:** ${banDuration}` +
            banExpiryLine + banNotesLine + banIssuedLine +
            `\n\n**Full Infraction History:**\n${infractionLines}` +
            `\n\n[UUCS User](${websiteUserUrl}) · [UUCS Appeals](${appealsUrl})`
          )
          .setColor('#e74c3c')
          .setTimestamp();

        await thread.send({
          content: `<@${clicker.id}>\n${staffPing} — new appeal received.`,
          embeds: [embed],
        });

        // Immediately link the active ban to this thread
        await axios.post(
          `${websiteUrl}/api/staff/infractions/appeal-thread`,
          { infractionId, threadId: thread.id, guildId: guild.id, threadUrl },
          { headers: { 'x-api-secret': process.env.API_SECRET }, timeout: 10000 }
        );

        await interaction.editReply({
          content: `✅ Appeal thread created: <#${thread.id}>\n\nYour active ban has been submitted for review. Staff will be in touch.`,
        });
        return;
      }

      // ── Case 3: No active ban — user picks infraction ──
      const appealable = allInfractions.filter(
        (inf: any) => !inf.appealStatus || inf.appealStatus === 'NONE'
      );

      let appealableIdx = 0;
      const infractionLines = allInfractions.map((inf: any) => {
        const isAppealable = !inf.appealStatus || inf.appealStatus === 'NONE';
        if (isAppealable) {
          appealableIdx++;
          return `**[${appealableIdx}]** ${fmtInfraction(inf)}`;
        }
        return `~~${fmtInfraction(inf)}~~`;
      }).join('\n');

      const embed = new EmbedBuilder()
        .setTitle(`📋 Appeal: ${clicker.username}`)
        .setDescription(
          `**User:** <@${clicker.id}>` +
          (armaUsername ? ` | **Arma name:** ${armaUsername}` : '') +
          `\n\n**Statement:**\n${appealMessage}` +
          `\n\n**Infraction History:**\n${infractionLines}` +
          `\n\n[UUCS User](${websiteUserUrl})`
        )
        .setColor('#e74c3c')
        .setTimestamp();

      const buttons: ButtonBuilder[] = appealable.map((inf: any, i: number) =>
        new ButtonBuilder()
          .setCustomId(`uucs_appeal_infraction_${inf._id.toString()}`)
          .setLabel(`${i + 1}`)
          .setStyle(ButtonStyle.Secondary)
      );

      const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];
      for (let i = 0; i < buttons.length; i += 5) {
        buttonRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(i, i + 5)));
      }

      await thread.send({
        content: `<@${clicker.id}> — please click the number of the infraction you wish to appeal.\n${staffPing} — new appeal received.`,
        embeds: [embed],
        components: buttonRows,
      });

      await interaction.editReply({
        content: `✅ Appeal thread created: <#${thread.id}>\n\nPlease go to the thread and click the number of the infraction you wish to appeal.`,
      });
    } catch (err: any) {
      console.error('Error handling appeal modal submit:', err);
      await interaction.editReply({ content: `❌ An error occurred: ${err.message}` });
    }
  }

  private async handleAppealInfractionSelect(interaction: any): Promise<void> {
    const infractionId = interaction.customId.replace('uucs_appeal_infraction_', '');

    await interaction.deferReply({ ephemeral: true });

    try {
      const guild = interaction.guild;
      const threadId = interaction.channelId;
      const threadUrl = `https://discord.com/channels/${guild.id}/${threadId}`;
      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';

      const { ObjectId } = await import('mongodb');
      const infraction = await this.db.collection('infractions').findOne(
        { _id: new ObjectId(infractionId) }
      );

      await axios.post(
        `${websiteUrl}/api/staff/infractions/appeal-thread`,
        { infractionId, threadId, guildId: guild.id, threadUrl },
        { headers: { 'x-api-secret': process.env.API_SECRET }, timeout: 10000 }
      );

      // Update the original message — add links + footer, remove buttons
      try {
        const originalEmbed = interaction.message.embeds[0];
        const date = infraction?.timestamp
          ? new Date(infraction.timestamp).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
          : '?';
        const duration = infraction?.durationMinutes
          ? `${infraction.durationMinutes / 60}h`
          : (infraction?.type === 'LIFE_BAN' || infraction?.type === 'BLACKLIST' ? 'Permanent' : '–');

        const clickerDiscordId = infraction?.targetDiscordId || '';
        const uucsUserUrl = clickerDiscordId
          ? `${websiteUrl}/dashboard/staff/users?q=${clickerDiscordId}`
          : `${websiteUrl}/dashboard/staff/users`;
        const appealsUrl = `${websiteUrl}/dashboard?openAppeal=${infractionId}`;

        const existingDesc = originalEmbed.description || '';
        const updatedDesc = existingDesc.replace(/\[UUCS User\]\([^)]+\)$/, '')
          + `\n[UUCS User](${uucsUserUrl}) · [UUCS Appeals](${appealsUrl})`;

        const updatedEmbed = EmbedBuilder.from(originalEmbed)
          .setColor('#f39c12')
          .setDescription(updatedDesc)
          .setFooter({ text: `✅ Appealing: ${infraction?.type ?? '?'} / ${infraction?.ruleId ?? '?'} | ${date} | ${duration}` });

        await interaction.message.edit({ embeds: [updatedEmbed], components: [] });
      } catch (_) { /* best effort */ }

      await interaction.editReply({
        content: `✅ Your appeal for the **${infraction?.type ?? 'infraction'} / ${infraction?.ruleId ?? '?'}** has been submitted. Staff will review it shortly.`,
      });
    } catch (err: any) {
      console.error('Error linking appeal infraction:', err);
      await interaction.editReply({ content: `❌ An error occurred: ${err.message}` });
    }
  }

  private async handleAppealLinkAccount(interaction: any): Promise<void> {
    const clicker = interaction.user;
    const appealerDiscordId = interaction.customId.replace('uucs_appeal_link_btn_', '');

    try {
      // Staff-only check
      const guild = interaction.guild;
      const member = await guild.members.fetch(clicker.id).catch(() => null);
      if (!member) {
        await interaction.reply({ content: '❌ Could not verify your roles.', ephemeral: true });
        return;
      }
      const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID || '';
      const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID || '';
      const modRoleId = process.env.DISCORD_MOD_ROLE_ID || '';
      const isStaff = (adminRoleId && member.roles.cache.has(adminRoleId)) ||
                      (gmRoleId && member.roles.cache.has(gmRoleId)) ||
                      (modRoleId && member.roles.cache.has(modRoleId));
      if (!isStaff) {
        await interaction.reply({ content: '❌ Only staff can link accounts.', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`uucs_appeal_link_modal_${appealerDiscordId}`)
        .setTitle('Link UUCS Profile');

      const platformIdInput = new TextInputBuilder()
        .setCustomId('platform_id')
        .setLabel('Arma Platform ID (Steam64 or BI ID)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('e.g. 76561198000000001')
        .setRequired(true);

      modal.addComponents(
        new ActionRowBuilder<ModalActionRowComponentBuilder>().addComponents(platformIdInput),
      );
      await interaction.showModal(modal);
    } catch (err: any) {
      console.error('Error handling appeal link account button:', err);
      try {
        await interaction.reply({ content: `❌ An error occurred: ${err.message}`, ephemeral: true });
      } catch (_) { /* already replied */ }
    }
  }

  private async handleAppealLinkModalSubmit(interaction: any): Promise<void> {
    const appealerDiscordId = interaction.customId.replace('uucs_appeal_link_modal_', '');
    const platformId = interaction.fields.getTextInputValue('platform_id')?.trim();

    await interaction.deferReply({ ephemeral: true });

    try {
      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
      const threadId = interaction.channelId;
      const guild = interaction.guild;
      const threadUrl = `https://discord.com/channels/${guild.id}/${threadId}`;

      const res = await axios.post(
        `${websiteUrl}/api/staff/users/link-discord-to-arma`,
        { discordId: appealerDiscordId, platformId, threadId, guildId: guild.id, threadUrl },
        { headers: { 'x-api-secret': process.env.API_SECRET }, timeout: 10000 }
      );

      const { linkedUser, linkedInfraction } = res.data;

      // Update the thread message to reflect the newly linked account
      try {
        const channel = await guild.channels.fetch(threadId).catch(() => null) as any;
        if (channel) {
          const messages = await channel.messages.fetch({ limit: 10 });
          const botMsg = messages.find((m: any) => m.author.bot && m.embeds?.length > 0);
          if (botMsg) {
            const originalEmbed = botMsg.embeds[0];
            const uucsUserUrl = `${websiteUrl}/dashboard/staff/users?q=${appealerDiscordId}`;
            const appealsUrl = linkedInfraction
              ? `${websiteUrl}/dashboard?openAppeal=${linkedInfraction._id}`
              : `${websiteUrl}/dashboard`;

            const unlinkedMarker = '\n\n⚠️ **This Discord account has no linked UUCS profile.**';
            let newDesc = (originalEmbed.description || '').split(unlinkedMarker)[0];

            if (linkedInfraction) {
              const fmtDate = (d: any) => new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
              const infractionId = linkedInfraction._id?.toString();
              const date = fmtDate(linkedInfraction.timestamp);
              const dur = linkedInfraction.durationMinutes
                ? `${Math.round(linkedInfraction.durationMinutes / 60 / 24)} day(s)`
                : (linkedInfraction.type === 'LIFE_BAN' || linkedInfraction.type === 'BLACKLIST' ? 'Permanent' : '–');
              newDesc += `\n\n✅ **Linked to:** ${linkedUser?.nickname || linkedUser?.username || 'User'} (platform: \`${platformId}\`)` +
                `\n**Active ban linked:** ${linkedInfraction.type} / ${linkedInfraction.ruleId} | ${date} | ${dur}` +
                `\n\n[UUCS User](${uucsUserUrl}) · [UUCS Appeals](${appealsUrl})`;
            } else {
              newDesc += `\n\n✅ **Linked to:** ${linkedUser?.nickname || linkedUser?.username || 'User'} (platform: \`${platformId}\`)` +
                `\n_No active ban found for this platform ID._` +
                `\n\n[UUCS User](${uucsUserUrl})`;
            }

            const updatedEmbed = EmbedBuilder.from(originalEmbed)
              .setColor(linkedInfraction ? '#e74c3c' : '#2ecc71')
              .setDescription(newDesc);

            const linkBtn = new ButtonBuilder()
              .setCustomId(`uucs_appeal_link_btn_${appealerDiscordId}`)
              .setLabel('🔗 Link to UUCS Profile')
              .setStyle(ButtonStyle.Secondary)
              .setDisabled(true);

            await botMsg.edit({
              embeds: [updatedEmbed],
              components: [new ActionRowBuilder<ButtonBuilder>().addComponents(linkBtn)],
            });
          }
        }
      } catch (_) { /* best effort */ }

      const linkedName = linkedUser?.nickname || linkedUser?.username || 'Unknown';
      await interaction.editReply({
        content: `✅ Discord user <@${appealerDiscordId}> has been linked to UUCS profile **${linkedName}** (platform: \`${platformId}\`).` +
          (linkedInfraction ? `\n\nActive ban **${linkedInfraction.type} / ${linkedInfraction.ruleId}** has been linked to this appeal thread.` : ''),
      });
    } catch (err: any) {
      console.error('Error handling appeal link modal submit:', err);
      const msg = err.response?.data?.error || err.message;
      await interaction.editReply({ content: `❌ Failed to link account: ${msg}` });
    }
  }
}
