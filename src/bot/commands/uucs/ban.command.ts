import { SlashCommandPipe } from '@discord-nestjs/common';
import {
  Command,
  Handler,
  InteractionEvent,
  Param,
  ParamType,
  EventParams,
} from '@discord-nestjs/core';
import {
  ChatInputCommandInteraction,
  ClientEvents,
  EmbedBuilder,
  GuildMember,
  TextChannel,
} from 'discord.js';
import { InjectDb } from 'nest-mongodb';
import * as mongo from 'mongodb';
import axios from 'axios';
import { COLOR_ERROR } from '../../../helpers/colors';

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
    description: 'Ban duration in hours (0 for permanent/life ban)',
    required: false,
    type: ParamType.INTEGER,
  })
  duration?: number;

  @Param({
    description: 'Platforms (BOTH, ARMA, DISCORD)',
    required: false,
    type: ParamType.STRING,
  })
  platforms?: string;

  @Param({
    description: 'Evidence File Upload (Drag & Drop here)',
    required: false,
    type: ParamType.ATTACHMENT,
  })
  evidence_file?: any;

  @Param({
    description: 'Evidence Image URL (pasted link)',
    required: false,
    type: ParamType.STRING,
  })
  evidence_url?: string;
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

    // Permission check: Admin or Reforger GM roles
    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    const hasPermission =
      member.roles.cache.has(adminRoleId) || member.roles.cache.has(gmRoleId);

    if (!hasPermission) {
      await interaction.reply({
        content: 'You do not have permission to run this command.',
        ephemeral: true,
      });
      return;
    }

    await interaction.deferReply({ ephemeral: true });

    try {
      const targetUserId = options.user;
      const ruleId = options.rule;
      const reason = options.reason || 'No reason provided';
      const durationHours = options.duration ?? 0;
      const durationMinutes = durationHours * 60;

      const type = durationHours === 0 ? 'LIFE_BAN' : 'BAN';

      const platformsInput = options.platforms?.toUpperCase() || 'BOTH';
      let platforms = ['ARMA', 'DISCORD'];
      if (platformsInput === 'ARMA') platforms = ['ARMA'];
      else if (platformsInput === 'DISCORD') platforms = ['DISCORD'];

      const evidenceUrls: string[] = [];
      if (options.evidence_url) {
        evidenceUrls.push(options.evidence_url);
      }
      if (options.evidence_file && options.evidence_file.url) {
        evidenceUrls.push(options.evidence_file.url);
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
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        },
      );

      if (response.data.ok) {
        // Apply Discord action if needed (ban)
        const targetMember = await guild.members
          .fetch(targetUserId)
          .catch(() => null);
        if (targetMember) {
          await targetMember.ban({ reason });
        } else {
          await guild.bans.create(targetUserId, { reason });
        }

        await interaction.editReply({
          content: `Successfully issued ${type} for <@${targetUserId}>.`,
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
