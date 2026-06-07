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
import { COLOR_OK } from '../../../helpers/colors';

class WarnSlashCommandParams {
  @Param({ description: 'User to warn', required: true, type: ParamType.USER })
  user: string;

  @Param({
    description: 'Rule to select (start typing to search)',
    required: true,
    type: ParamType.STRING,
    autocomplete: true,
  })
  rule: string;

  @Param({
    description: 'Reason for the warning',
    required: false,
    type: ParamType.STRING,
  })
  reason?: string;

  @Param({
    description: 'Timeout duration in hours (e.g. 24)',
    required: false,
    type: ParamType.INTEGER,
  })
  timeout?: number;

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
  name: 'warn',
  description: 'Issues a warning to a user in the UUCS system',
})
export class WarnCommand {
  constructor(@InjectDb() private readonly db: mongo.Db) {}

  @Handler()
  async onWarn(
    @InteractionEvent(SlashCommandPipe) options: WarnSlashCommandParams,
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
      const timeoutHours = options.timeout ?? 0;
      const durationMinutes = timeoutHours * 60;

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
          type: 'WARNING',
          ruleId,
          reason,
          durationMinutes,
          platforms: ['ARMA', 'DISCORD'],
          evidenceUrls,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
        },
      );

      if (response.data.ok) {
        // Apply timeout if requested
        const targetMember = await guild.members
          .fetch(targetUserId)
          .catch(() => null);
        if (durationMinutes > 0 && targetMember) {
          await targetMember.timeout(durationMinutes * 60 * 1000, reason);
        }

        await interaction.editReply({
          content: `Successfully issued warning for <@${targetUserId}>.`,
        });
      } else {
        await interaction.editReply({
          content: `Failed to issue warning: ${response.data.error}`,
        });
      }
    } catch (error: any) {
      console.error('Warn Command Error:', error);
      await interaction.editReply({
        content: `An error occurred: ${error.message}`,
      });
    }
  }
}
