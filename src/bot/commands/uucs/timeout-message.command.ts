import { Command, Handler, InteractionEvent } from '@discord-nestjs/core';
import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  ModalBuilder,
  LabelBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  GuildMember,
} from 'discord.js';

@Command({
  name: 'Timeout',
  type: ApplicationCommandType.Message,
})
export class TimeoutMessageCommand {
  @Handler()
  async onTimeout(
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
      .setCustomId(`uucs_timeout_modal_${targetUser.id}_${targetMessage.id}`)
      .setTitle(`Timeout: ${targetUser.username}`)
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Timeout Duration')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId('duration_minutes')
              .setPlaceholder('Select duration...')
              .addOptions([
                new StringSelectMenuOptionBuilder().setLabel('5 min').setValue('5'),
                new StringSelectMenuOptionBuilder().setLabel('10 min').setValue('10'),
                new StringSelectMenuOptionBuilder().setLabel('1 hour').setValue('60'),
                new StringSelectMenuOptionBuilder().setLabel('24 hour').setValue('1440'),
              ]),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Public Reason')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('reason')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Enter a reason this will be sent as a DM to the user and stored in the UUCS history')
              .setRequired(true),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Private Reason')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('private_reason')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Enter a reason that is only displayed for staff in the UUCS history panel')
              .setRequired(false),
          ),
      );

    await interaction.showModal(modal);
  }
}
