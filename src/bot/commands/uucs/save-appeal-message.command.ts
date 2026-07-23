import { Command, Handler, InteractionEvent } from '@discord-nestjs/core';
import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  GuildMember,
} from 'discord.js';
import axios from 'axios';

@Command({
  name: 'Save to Appeal',
  type: ApplicationCommandType.Message,
})
export class SaveAppealMessageCommand {
  @Handler()
  async onSaveToAppeal(
    @InteractionEvent() interaction: MessageContextMenuCommandInteraction,
  ): Promise<void> {
    if (!interaction.isMessageContextMenuCommand()) return;

    const member = interaction.member as GuildMember;
    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    const modRoleId = process.env.DISCORD_MOD_ROLE_ID;

    const isStaff =
      member.roles.cache.has(adminRoleId) ||
      member.roles.cache.has(gmRoleId) ||
      member.roles.cache.has(modRoleId);

    if (!isStaff) {
      await interaction.reply({ content: '❌ Only staff can save messages to appeals.', ephemeral: true });
      return;
    }

    const targetMessage = interaction.targetMessage;
    const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';

    try {
      const response = await axios.post(
        `${websiteUrl}/api/staff/infractions/save-message`,
        {
          threadId: interaction.channelId,
          content: targetMessage.content || '[No text content]',
          authorId: targetMessage.author.id,
          authorName: (interaction.guild?.members.cache.get(targetMessage.author.id))?.displayName
            || targetMessage.author.username,
          timestamp: targetMessage.createdAt.toISOString(),
          savedById: interaction.user.id,
          savedByName: member?.displayName || interaction.user.username,
        },
        {
          headers: { 'x-api-secret': process.env.API_SECRET },
          timeout: 10000,
        }
      );

      if (!response.data.ok) {
        await interaction.reply({
          content: `❌ ${response.data.error || 'Could not save — is this an appeal thread?'}`,
          ephemeral: true,
        });
        return;
      }

      await interaction.reply({ content: `✅ Message saved to the appeal record.`, ephemeral: true });
    } catch (err: any) {
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      await interaction.reply({ content: `❌ Error: ${msg}`, ephemeral: true });
    }
  }
}
