import { Command, Handler, InteractionEvent } from '@discord-nestjs/core';
import {
  ApplicationCommandType,
  UserContextMenuCommandInteraction,
} from 'discord.js';

@Command({
  name: 'Open UUCS',
  type: ApplicationCommandType.User,
})
export class OpenUucsCommand {
  @Handler()
  async onOpenUucs(
    @InteractionEvent() interaction: UserContextMenuCommandInteraction,
  ): Promise<void> {
    const targetUser = interaction.targetUser;
    const dashboardUrl = `${process.env.WEBSITE_URL}/dashboard/staff/users?q=${targetUser.id}`;

    await interaction.reply({
      content: `[Click here to open ${targetUser.username}'s UUCS Profile](${dashboardUrl})`,
      ephemeral: true,
    });
  }
}
