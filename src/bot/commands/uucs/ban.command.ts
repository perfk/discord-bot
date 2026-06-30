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
    description: 'Reason for the ban',
    required: false,
    type: ParamType.STRING,
  })
  reason?: string;

  @Param({
    description: 'Ban duration based on the selected rule options (autocomplete)',
    required: true,
    type: ParamType.STRING,
    autocomplete: true,
  })
  duration: string;

  @Choice({
    BOTH: 'BOTH',
    ARMA: 'ARMA',
    DISCORD: 'DISCORD',
  })
  @Param({
    description: 'Platforms to ban',
    required: true,
    type: ParamType.STRING,
  })
  platforms: string;

  @Param({
    description: 'Message Link or ID to associate with this ban as evidence',
    required: false,
    type: ParamType.STRING,
  })
  message?: string;

  @Param({
    description: 'Evidence File Upload (Drag & Drop here)',
    required: false,
    type: ParamType.ATTACHMENT,
  })
  evidence_file?: any;
}

function parseDurationStringToMinutes(durationStr: string): number | null {
  const lower = durationStr.toLowerCase().trim();
  if (lower.includes('perm') || lower.includes('life') || lower.includes('blacklist')) {
    return null; // Permanent
  }

  const match = lower.match(/^(\d+)\s*(week|month|year|day|hour|min)s?$/);
  if (match) {
    const value = parseInt(match[1]);
    const unit = match[2];
    if (unit.startsWith('week')) return value * 7 * 24 * 60;
    if (unit.startsWith('month')) return value * 30 * 24 * 60;
    if (unit.startsWith('year')) return value * 365 * 24 * 60;
    if (unit.startsWith('day')) return value * 24 * 60;
    if (unit.startsWith('hour')) return value * 60;
    if (unit.startsWith('min')) return value;
  }
  return null;
}

@Command({
  name: 'ban',
  description: 'Issues a ban to a user in the UUCS system',
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

    // Permission check: Admin, Reforger GM, or Discord Moderator roles
    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    const isDiscordMod = member.roles.cache.some((r) =>
      r.name.toLowerCase().includes('moderator'),
    );
    
    const isAdmin = member.roles.cache.has(adminRoleId);
    const isGM = member.roles.cache.has(gmRoleId);

    if (!isAdmin && !isGM && !isDiscordMod) {
      await interaction.reply({
        content: 'You do not have permission to run this command.',
        ephemeral: true,
      });
      return;
    }

    const durationMinutes = parseDurationStringToMinutes(options.duration);
    
    const isGMOnly = isGM && !isAdmin && !isDiscordMod;
    if (isGMOnly) {
      if (durationMinutes === null || durationMinutes > 24 * 60) {
        await interaction.reply({
          content: 'Game Masters can only issue temporary bans for a maximum of 24 hours.',
          ephemeral: true,
        });
        return;
      }
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const targetUserId = options.user;
      const ruleId = options.rule;
      const reason = options.reason || 'No reason provided';

      const type = durationMinutes === null ? 'LIFE_BAN' : 'BAN';

      const platformsInput = options.platforms.toUpperCase();

      let platforms = ['ARMA', 'DISCORD'];
      if (platformsInput === 'ARMA') platforms = ['ARMA'];
      else if (platformsInput === 'DISCORD') platforms = ['DISCORD'];

      const evidenceUrls: string[] = [];
      if (options.evidence_file && options.evidence_file.url) {
        evidenceUrls.push(options.evidence_file.url);
      }

      let discordMessageId = null;
      if (options.message) {
        let channelId = null;
        let messageId = null;
        const match = options.message.match(/channels\/\d+\/(\d+)\/(\d+)/);
        if (match) {
          channelId = match[1];
          messageId = match[2];
        } else {
          messageId = options.message.trim();
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

      // Fetch target user to make sure they exist
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
          content: `Successfully issued ${type === 'LIFE_BAN' ? 'perm Ban' : 'ban'} for <@${targetUserId}>.`,
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
