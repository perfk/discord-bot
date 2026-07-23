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
  name: 'Issue Ban',
  type: ApplicationCommandType.Message,
})
export class BanMessageCommand {
  @Handler()
  async onBanMessage(
    @InteractionEvent() interaction: MessageContextMenuCommandInteraction,
  ): Promise<void> {
    if (!interaction.isMessageContextMenuCommand()) return;

    const member = interaction.member as GuildMember;
    if (!member) return;

    // Permission check: Admin or Reforger GM roles
    const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
    const gmRoleId = process.env.DISCORD_REFORGERGM_ROLE_ID;
    const isBanStaff =
      member.roles.cache.has(adminRoleId) ||
      member.roles.cache.has(gmRoleId);

    if (!isBanStaff) {
      await interaction.reply({
        content: 'You do not have permission to run this command. (Admins and GMs only)',
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

    await interaction.reply({
      content: `### Ban **${targetUser.username}**\nClick below to open the website with this message pre-loaded as evidence.`,
      components: [row],
      ephemeral: true,
    });
  }
}
