import { SlashCommandPipe } from '@discord-nestjs/common';
import {
  Command,
  Handler,
  InteractionEvent,
  Param,
  ParamType,
  EventParams,
  Choice,
} from '@discord-nestjs/core';
import {
  ChatInputCommandInteraction,
  ClientEvents,
  GuildMember,
} from 'discord.js';
import { InjectDb } from 'nest-mongodb';
import * as mongo from 'mongodb';
import axios from 'axios';

class BanSlashCommandParams {
  @Param({ description: 'User to ban', required: true, type: ParamType.USER })
  user: string;

  @Param({
    description: 'Rule to select (start typing to search)',
    required: true,
    type: ParamType.STRING,
    autocomplete: true,
  })
  rule: string;

  @Param({
    description: 'Staff remarks / reason for the ban',
    required: true,
    type: ParamType.STRING,
  })
  staff_remarks: string;


  @Choice({
    BOTH: 'BOTH',
    ARMA: 'ARMA',
    DISCORD: 'DISCORD',
  })
  @Param({
    description: 'Platforms to ban (defaults: GM=ARMA, Moderator=DISCORD, both roles=BOTH)',
    required: false,
    type: ParamType.STRING,
  })
  platforms?: string;

  @Param({
    description: 'Discord message link or ID to associate with this ban as evidence',
    required: false,
    type: ParamType.STRING,
  })
  message_link?: string;

  @Param({
    description: 'Evidence File Upload (Drag & Drop here)',
    required: false,
    type: ParamType.ATTACHMENT,
  })
  evidence_file?: any;
}

const BAN_DURATION_MINUTES = 24 * 60; // 1440 — bans are always 24h; longer bans require admin vote or manual admin action

@Command({
  name: 'ban',
  description: 'Issues a ban to a user in the UUCS system (24h default, >24h requires admin vote)',
})
export class UucsBanCommand {
  constructor(@InjectDb() private readonly db: mongo.Db) {}

  @Handler()
  async onBan(
    @InteractionEvent(SlashCommandPipe) options: BanSlashCommandParams,
    @EventParams() args: ClientEvents['interactionCreate'],
  ): Promise<void> {
    const interaction = args[0] as ChatInputCommandInteraction;
    const member = interaction.member as GuildMember;
    const guild = interaction.guild;

    if (!member) {
      await interaction.reply({
        content: 'Unable to determine member. Please try again.',
        ephemeral: true,
      });
      return;
    }

    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    const isAdmin = member.roles.cache.has(adminRoleId);
    const isGM = member.roles.cache.has(gmRoleId);
    const isDiscordMod = member.roles.cache.some((r) =>
      r.name.toLowerCase().includes('moderator'),
    );

    if (!isAdmin && !isGM && !isDiscordMod) {
      await interaction.reply({
        content: 'You do not have permission to run this command.',
        ephemeral: true,
      });
      return;
    }

    // Determine platform default by role, or use explicit override
    let platformsInput: string;
    if (options.platforms) {
      platformsInput = options.platforms.toUpperCase();
      // Enforce role restrictions on manual overrides
      if (!isAdmin) {
        if (isDiscordMod && !isGM && platformsInput !== 'DISCORD') {
          await interaction.reply({
            content: 'Discord Moderators can only issue Discord bans.',
            ephemeral: true,
          });
          return;
        }
        if (isGM && !isDiscordMod && platformsInput !== 'ARMA') {
          await interaction.reply({
            content: 'Arma GMs can only issue Arma bans.',
            ephemeral: true,
          });
          return;
        }
      }
    } else {
      // Auto-default based on role
      if (isGM && isDiscordMod) platformsInput = 'BOTH';
      else if (isGM) platformsInput = 'ARMA';
      else if (isDiscordMod) platformsInput = 'DISCORD';
      else platformsInput = 'BOTH'; // admin fallback
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const targetUserId = options.user;
      const ruleId = options.rule;
      const reason = options.staff_remarks;
      const durationMinutes = BAN_DURATION_MINUTES;
      const type = 'BAN';

      let platforms = ['ARMA', 'DISCORD'];
      if (platformsInput === 'ARMA') platforms = ['ARMA'];
      else if (platformsInput === 'DISCORD') platforms = ['DISCORD'];

      const evidenceUrls: string[] = [];
      if (options.evidence_file && options.evidence_file.url) {
        evidenceUrls.push(options.evidence_file.url);
      }

      let discordMessageId = null;
      if (options.message_link) {
        let channelId = null;
        let messageId = null;
        const match = options.message_link.match(/channels\/\d+\/(\d+)\/(\d+)/);
        if (match) {
          channelId = match[1];
          messageId = match[2];
        } else {
          messageId = options.message_link.trim();
        }

        discordMessageId = messageId;

        try {
          let targetMsg = null;
          if (channelId) {
            const channel = guild.channels.cache.get(channelId);
            if (channel && channel.isTextBased()) {
              targetMsg = await channel.messages.fetch(messageId).catch(() => null);
            }
          } else {
            targetMsg = await interaction.channel.messages.fetch(messageId).catch(() => null);
          }

          if (targetMsg && targetMsg.attachments.size > 0) {
            targetMsg.attachments.forEach((att: any) => {
              if (att.url && !evidenceUrls.includes(att.url)) {
                evidenceUrls.push(att.url);
              }
            });
          }
        } catch (err) {
          console.error('Failed to auto-archive target message attachments:', err);
        }
      }

      const targetUser = await interaction.client.users
        .fetch(targetUserId)
        .catch(() => null);
      if (!targetUser) {
        await interaction.editReply({
          content: `Could not find target user with ID: ${targetUserId}`,
        });
        return;
      }

      const websiteUrl = process.env.WEBSITE_URL;
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
          discordMessageId,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        },
      );

      if (response.data.ok) {
        await interaction.editReply({
          content: `Successfully issued 24h ban for <@${targetUserId}>.`,
        });
      } else {
        await interaction.editReply({
          content: `Failed to issue ban: ${response.data.error}`,
        });
      }
    } catch (error: any) {
      console.error('Ban Command Error:', error);
      await interaction.editReply({
        content: `An error occurred: ${error.message}`,
      });
    }
  }
}
