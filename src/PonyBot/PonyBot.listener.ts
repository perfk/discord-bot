import { Injectable } from '@nestjs/common';
import { On } from '@discord-nestjs/core';
import { Message } from 'discord.js';
import { MongoClient, Collection } from 'mongodb';

interface CooldownMap {
  [trigger: string]: number; // Timestamp in milliseconds when cooldown expires
}

@Injectable()
export class PonyBotListener {
  private readonly COOLDOWN_DURATION = 120 * 1000; // 120 seconds in milliseconds
  private readonly EXCLUDED_CHANNEL_IDS = [
    '1345421564568404052',
    '1345421588283260998',
  ];
  private cooldowns: CooldownMap = {};
  private triggerImagesCollection: Collection;

  constructor() {
    const mongoClient = new MongoClient(process.env.MONGO_HOST);
    const db = mongoClient.db('ponybot');
    this.triggerImagesCollection = db.collection('triggerImages');
  }

  @On('messageCreate')
  async onMessage(message: Message): Promise<void> {
    if (message.author.bot) return;

    if (this.EXCLUDED_CHANNEL_IDS.includes(message.channel.id)) return;

    const content = message.content.toLowerCase();
    const now = Date.now();

    // Query triggerImages collection for matching triggers
    const triggerDocs = await this.triggerImagesCollection
      .find({ trigger: { $in: content.split(' ') } })
      .toArray();

    if (triggerDocs.length === 0) return;

    // Select random trigger from matches
    const triggerDoc = this.randomChoice(triggerDocs);
    const trigger = triggerDoc.trigger;

    // Check cooldown
    const triggerCooldown = this.cooldowns[trigger];
    if (triggerCooldown && now < triggerCooldown) {
      const timeLeft = Math.ceil((triggerCooldown - now) / 1000);
      await (message.channel as any).send(
        `${trigger} is on cooldown! ${timeLeft} seconds remaining.`,
      );
      return;
    }

    // Send random image from the trigger's images array
    const imageUrl = this.randomChoice(triggerDoc.images);
    await (message.channel as any).send(imageUrl);
    this.cooldowns[trigger] = now + this.COOLDOWN_DURATION;
  }

  private randomChoice<T>(array: T[]): T {
    return array[Math.floor(Math.random() * array.length)];
  }
}
