import { Command, Handler, InteractionEvent } from '@discord-nestjs/core';
import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  GuildMember,
} from 'discord.js';

@Command({
  name: 'Warn User',
  type: ApplicationCommandType.Message,
})
export class WarnMessageCommand {
  @Handler()
  async onWarnMessage(
    @InteractionEvent() interaction: MessageContextMenuCommandInteraction,
  ): Promise<void> {
    if (!interaction.isMessageContextMenuCommand()) return;

    const member = interaction.member as GuildMember;
    if (!member) return;

    // Permission check: Admin, Reforger GM, or Discord Moderator roles
    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    const isStaff =
      member.roles.cache.has(adminRoleId) ||
      member.roles.cache.has(gmRoleId) ||
      member.roles.cache.some((r) =>
        r.name.toLowerCase().includes('moderator'),
      );

    if (!isStaff) {
      await interaction.reply({
        content: 'You do not have permission to run this command.',
        ephemeral: true,
      });
      return;
    }

    const targetMessage = interaction.targetMessage;
    const targetUser = targetMessage.author;
    const messageUrl = `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${targetMessage.id}`;

    const websiteUrl = process.env.WEBSITE_URL;
    const linkUrl = `${websiteUrl}/dashboard/staff/users?q=${targetUser.id}&msgUrl=${encodeURIComponent(messageUrl)}`;

    const button = new ButtonBuilder()
      .setLabel('Issue Infraction on Website')
      .setStyle(ButtonStyle.Link)
      .setURL(linkUrl);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(button);

    const commandText = `/warn user:${targetUser.id} message:${messageUrl}`;

    await interaction.reply({
      content: `### Warn **${targetUser.username}**\nCopy the command below and paste it in the chat:\n\`\`\`\n${commandText}\n\`\`\``,
      components: [row],
      ephemeral: true,
    });
  }
}
