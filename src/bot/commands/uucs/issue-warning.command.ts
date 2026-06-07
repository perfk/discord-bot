import { Command, Handler, InteractionEvent } from '@discord-nestjs/core';
import {
  ApplicationCommandType,
  MessageContextMenuCommandInteraction,
  ModalBuilder,
  LabelBuilder,
  UserSelectMenuBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  FileUploadBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import { InjectDb } from 'nest-mongodb';
import * as mongo from 'mongodb';

@Command({
  name: 'Issue Warning',
  type: ApplicationCommandType.Message,
})
export class IssueWarningCommand {
  constructor(@InjectDb() private readonly db: mongo.Db) {}

  @Handler()
  async onIssueWarning(
    @InteractionEvent() interaction: MessageContextMenuCommandInteraction,
  ): Promise<void> {
    if (!interaction.isMessageContextMenuCommand()) return;

    const targetMessage = interaction.targetMessage;
    const targetUser = targetMessage.author;

    // Fetch active rules from the database to populate the select menu
    const rules = await this.db
      .collection('rules')
      .find({ isActive: true })
      .sort({ category: 1, order: 1, ruleId: 1 })
      .limit(25)
      .toArray();

    const options = rules.map((rule) => {
      let label = `[${rule.ruleId}] ${rule.title}`;
      if (label.length > 100) {
        label = label.substring(0, 97) + '...';
      }
      let description = rule.description || '';
      if (description.length > 100) {
        description = description.substring(0, 97) + '...';
      }
      const option = new StringSelectMenuOptionBuilder()
        .setLabel(label)
        .setValue(rule.ruleId);
      if (description) {
        option.setDescription(description);
      }
      return option;
    });

    const modal = new ModalBuilder()
      .setCustomId(`uucs_direct_warning_modal_${targetMessage.id}`)
      .setTitle(`Issue Warning: ${targetUser.username}`)
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('User to Warn')
          .setUserSelectMenuComponent(
            new UserSelectMenuBuilder()
              .setCustomId('target_user')
              .setDefaultUsers([targetUser.id]),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Infraction Rule')
          .setStringSelectMenuComponent(
            new StringSelectMenuBuilder()
              .setCustomId('rule_id')
              .setPlaceholder('Select a rule infraction...')
              .addOptions(options),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Reason / Context')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('reason')
              .setStyle(TextInputStyle.Paragraph)
              .setPlaceholder('Explain why this warning is being issued...')
              .setRequired(false),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Timeout Duration (Hours)')
          .setTextInputComponent(
            new TextInputBuilder()
              .setCustomId('timeout_hours')
              .setStyle(TextInputStyle.Short)
              .setValue('0')
              .setPlaceholder('Timeout in hours (0 for none)')
              .setRequired(false),
          ),
      )
      .addLabelComponents(
        new LabelBuilder()
          .setLabel('Evidence Upload')
          .setFileUploadComponent(
            new FileUploadBuilder()
              .setCustomId('evidence_files')
              .setMinValues(0)
              .setMaxValues(10)
              .setRequired(false),
          ),
      );

    await interaction.showModal(modal);
  }
}
