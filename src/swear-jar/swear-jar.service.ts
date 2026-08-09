import { Injectable, OnModuleInit } from '@nestjs/common';
import { DiscordClientProvider, Once, On } from '@discord-nestjs/core';
import { TextChannel } from 'discord.js';
import { MongoClient, Collection } from 'mongodb';

@Injectable()
export class SwearJarService implements OnModuleInit {
  private swearJarCount = 0;
  private swearJarCollection: Collection;

  constructor(private readonly discordProvider: DiscordClientProvider) {
    const mongoClient = new MongoClient(process.env.MONGO_HOST);
    const db = mongoClient.db('ponybot');
    this.swearJarCollection = db.collection('swearJar');
  }

  async onModuleInit() {
    await this.loadSwearJarData();
  }

  @Once('clientReady')
  onReady() {
    console.log('Swear Jar service is ready!');
  }

  @On('messageCreate')
  async onMessage(message: any) {
    if (message.author.bot) return;

    const content = message.content.toLowerCase();
    const channel = message.channel;

    // Load trigger terms from MongoDB
    const triggerDocs = await this.swearJarCollection
      .find({ type: 'trigger' })
      .toArray();
    const triggerTerms = triggerDocs.map(doc => doc.term);

    // Split into words for single-word checks
    const words = content.split(/\s+/).filter(word => word.length > 0);

    // Check for trigger terms
    const termFound = triggerTerms.some(term => {
      if (term.includes(' ')) {
        return content.includes(term);
      } else {
        return words.includes(term);
      }
    });

    if (termFound) {
      this.swearJarCount += 1;
      console.log(`Swear Jar updated: ${this.swearJarCount} GC Bucks`);

      if (channel instanceof TextChannel) {
        await channel.send(`A GC Buck has been withdrawn from your account and put into the swear jar. Total: ${this.swearJarCount} GC Bucks`);
      } else {
        console.log(`Could not update Swear Jar for message - not a text channel`);
      }

      await this.saveSwearJarData();
    }
  }

  private async loadSwearJarData() {
    try {
      const countDoc = await this.swearJarCollection.findOne({ type: 'count' });
      this.swearJarCount = countDoc?.value || 0;
      console.log(`Swear Jar data loaded: ${this.swearJarCount} GC Bucks`);
    } catch (error) {
      console.log('Error loading Swear Jar data, starting fresh:', error);
      this.swearJarCount = 0;
      await this.saveSwearJarData(); // Initialize the count document if it doesn’t exist
    }
  }

  private async saveSwearJarData() {
    try {
      await this.swearJarCollection.updateOne(
        { type: 'count' },
        { $set: { value: this.swearJarCount } },
        { upsert: true } // Create the document if it doesn’t exist
      );
      console.log('Swear Jar data saved to MongoDB.');
    } catch (error) {
      console.error('Error saving Swear Jar data:', error);
    }
  }

  public getSwearJarCount(): number {
    return this.swearJarCount;
  }
}