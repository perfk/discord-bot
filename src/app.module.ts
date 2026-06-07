import { BotModule } from './bot/bot.module';
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { UsersController } from './users/users.controller';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { MissionsController } from './missions/missions.controller';
import { ServerController } from './server/server.controller';
import { UucsController } from './uucs/uucs.controller';
import { MongoModule } from 'nest-mongodb';
import { DiscordModule } from '@discord-nestjs/core';
import { GatewayIntentBits, Partials } from 'discord.js';
 

@Module({
  imports: [
    ConfigModule.forRoot(),
    DiscordModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: (configService: ConfigService) => ({
        token: configService.get('DISCORD_BOT_TOKEN'),
        registerCommandOptions: [
          {
            forGuild: configService.get('DISCORD_SERVER_ID'),
            removeCommandsBefore: true,
          },
        ],

        discordClientOptions: {
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.GuildMessageReactions,
          ],
          partials: [
            Partials.Message,
            Partials.Channel,
            Partials.Reaction,
            Partials.User,
          ],
        },
      }),
      inject: [ConfigService],
    }),
    BotModule,
    MongoModule.forRoot(process.env.MONGO_HOST, 'prod'),
  ],
  controllers: [UsersController, MissionsController, ServerController, AppController, UucsController],
  providers: [AppService],
})
export class AppModule {}
