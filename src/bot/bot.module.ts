import { BotGateway } from './bot.gateway';
import { DiscordModule } from '@discord-nestjs/core';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { TestServersCommands } from './commands/server/testservers.command';
import { MainServerSubCommand } from './commands/subcommands/main.subcommand';
import { ConflictServerSubCommand } from './commands/subcommands/conflict.subcommand';
import { StartTimeCommand } from './commands/subcommands/starttime.command';
import { SwearJarModule } from '../swear-jar/swear-jar.module';
import { VoiceRolesModule } from '../voice-roles/voice-roles.module';
import { PonyBotListener } from '../PonyBot/PonyBot.listener';
import { ReactionHandler } from './events/reaction.handler';
import { SessionsModule } from '../sessions/sessions.module';


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
    PonyBotListener,
    ReactionHandler,
  ],
})
export class BotModule { }
