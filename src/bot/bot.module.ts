import { BotGateway } from './bot.gateway';
import { DiscordModule } from '@discord-nestjs/core';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { TestServersCommands } from './commands/server/testservers.command';
import { MainServerSubCommand } from './commands/subcommands/main.subcommand';
import { ConflictServerSubCommand } from './commands/subcommands/conflict.subcommand';
import { StartTimeCommand } from './commands/subcommands/starttime.command';
import { RoleScanCommand } from './commands/subcommands/rolescan.command';
import { BanCommand } from './commands/subcommands/ban.command';
import { GuestResetCommand } from './commands/subcommands/guestreset.command';
import { SwearJarModule } from '../swear-jar/swear-jar.module';
import { VoiceRolesModule } from '../voice-roles/voice-roles.module';
import { PonyBotListener } from '../PonyBot/PonyBot.listener';
import { ReactionHandler } from './events/reaction.handler';
import { SessionsModule } from '../sessions/sessions.module';

import { OpenUucsCommand } from './commands/uucs/open-uucs.command';
import { WarnCommand } from './commands/uucs/warn.command';
import { UucsBanCommand } from './commands/uucs/ban.command';
import { TimeoutCommand } from './commands/uucs/timeout.command';
import { SpammerBanCommand } from './commands/uucs/spammer-ban.command';
import { IssueInfractionCommand } from './commands/uucs/issue-infraction.command';
import { WarnMessageCommand } from './commands/uucs/warn-message.command';
import { BanMessageCommand } from './commands/uucs/ban-message.command';
import { TimeoutMessageCommand } from './commands/uucs/timeout-message.command';
import { SaveAppealMessageCommand } from './commands/uucs/save-appeal-message.command';

@Module({
  imports: [
    DiscordModule.forFeature(),
    ScheduleModule.forRoot(),
    SwearJarModule,
    VoiceRolesModule,
    SessionsModule,
  ],
  exports: [DiscordModule],
  providers: [
    BotGateway,
    TestServersCommands,
    MainServerSubCommand,
    ConflictServerSubCommand,
    StartTimeCommand,
    RoleScanCommand,
    BanCommand,
    GuestResetCommand,
    PonyBotListener,
    ReactionHandler,
    OpenUucsCommand,
    WarnCommand,
    UucsBanCommand,
    TimeoutCommand,
    SpammerBanCommand,
    IssueInfractionCommand,
    WarnMessageCommand,
    BanMessageCommand,
    TimeoutMessageCommand,
    SaveAppealMessageCommand,
  ],
})
export class BotModule { }
