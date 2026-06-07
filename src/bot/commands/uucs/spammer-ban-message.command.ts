import { Command, Handler, InteractionEvent } from '@discord-nestjs/core';
import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  GuildMember,
} from 'discord.js';

@Command({
  name: 'Spammer Ban',
  type: ApplicationCommandType.Message,
})
export class SpammerBanMessageCommand {
  @Handler()
  async onSpammerBan(
    @InteractionEvent() interaction: MessageContextMenuCommandInteraction,
  ): Promise<void> {
    if (!interaction.isMessageContextMenuCommand()) return;

    const member = interaction.member as GuildMember;
    if (!member) return;

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

    const targetMessage = interaction.targetMessage;
    const targetUser = targetMessage.author;

    const modal = new ModalBuilder()
      .setCustomId(`uucs_spammer_ban_modal_${targetUser.id}_${targetMessage.id}`)
      .setTitle(`Spammer Ban: ${targetUser.username}`)
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Warning: Spammer Role Assignment')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('info')
              .setStyle(TextInputStyle.Short)
              .setValue('This assigns the Spammer role. They will only see start-here.')
              .setRequired(false),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Reason / Remarks')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('reason')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Enter reason for this spammer ban...')
              .setRequired(true),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Type CONFIRM to execute')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('confirm')
              .setStyle(TextInputStyle.Short)
              .setPlaceholder('CONFIRM')
              .setRequired(true),
          ),
      );

    await interaction.showModal(modal);
  }
}
