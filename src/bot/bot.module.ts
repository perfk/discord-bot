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
import { IssueWarningCommand } from './commands/uucs/issue-warning.command';
import { IssueBanCommand } from './commands/uucs/issue-ban.command';
import { IssueWarningUserCommand } from './commands/uucs/issue-warning-user.command';
import { WarnCommand } from './commands/uucs/warn.command';
import { UucsBanCommand } from './commands/uucs/ban.command';
import { StartInfractionForumThreadCommand } from './commands/uucs/start-infraction-thread.command';
import { TimeoutUserCommand } from './commands/uucs/timeout-user.command';
import { TimeoutMessageCommand } from './commands/uucs/timeout-message.command';
import { SpammerBanUserCommand } from './commands/uucs/spammer-ban-user.command';
import { SpammerBanMessageCommand } from './commands/uucs/spammer-ban-message.command';

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
    IssueWarningCommand,
    IssueBanCommand,
    IssueWarningUserCommand,
    WarnCommand,
    UucsBanCommand,
    StartInfractionForumThreadCommand,
    TimeoutUserCommand,
    TimeoutMessageCommand,
    SpammerBanUserCommand,
    SpammerBanMessageCommand,
  ],
})
export class BotModule { }
