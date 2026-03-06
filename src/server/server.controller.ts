import { DiscordClientProvider } from '@discord-nestjs/core';
import { Body, Controller, Post } from '@nestjs/common';
import { ChannelType, EmbedBuilder, ForumChannel, TextChannel, ThreadChannel } from 'discord.js';
import { updateDefaultScenario } from '../helpers/reforger_server';
import { spawn } from 'child_process';
import { handleServerData } from '../helpers/reforger_server';

/**
 * In-memory map of ratable Discord messages.
 * Populated when reactions are added after an outcome is recorded.
 * key: Discord messageId  →  value: { uniqueName, historyEntryId }
 */
export const ratableMessages = new Map<string, { uniqueName: string; historyEntryId: string }>();

@Controller('server')
export class ServerController {
    constructor(private readonly discordProvider: DiscordClientProvider) { }

    /**
     * POST /server/set-scenario
     * Updates config.json with the new scenarioId and restarts the main server.
     * Called by the website when a GM clicks "Load Mission".
     */
    @Post('/set-scenario')
    async setScenario(@Body() body: { scenarioId: string; missionString?: string }): Promise<object> {
        const configPath = process.env.REFORGER_SERVER_CONFIG_PATH;
        const scriptPath = process.env.MAIN_REFORGER_SERVER_START_SCRIPT_PATH;

        if (configPath) {
            try {
                updateDefaultScenario(body.scenarioId, `${configPath}\\config.json`);
            } catch (err) {
                console.error('Failed to update config.json:', err);
                // Not fatal — proceed to restart
            }

            // Write mission_context.json so start.ps1 can forward the human-readable
            // mission name to the mock server's load signal during local development.
            if (body.missionString) {
                try {
                    const fs = require('fs');
                    const ctx = JSON.stringify({ missionString: body.missionString }, null, 2);
                    fs.writeFileSync(`${configPath}\\mission_context.json`, ctx, 'utf8');
                } catch (err) {
                    console.error('Failed to write mission_context.json:', err);
                }
            }
        }

        if (scriptPath) {
            try {
                const child = spawn('powershell.exe', ['-File', `${scriptPath}\\start.ps1`]);
                child.stdout.on('data', (data) => {
                    // Fire-and-forget — no channel to post to from this endpoint
                    console.log('[server restart stdout]', '' + data);
                });
                child.stderr.on('data', (data) => {
                    console.error('[server restart stderr]', '' + data);
                });
                child.stdin.end();
            } catch (err) {
                console.error('Failed to spawn restart script:', err);
            }
        }

        return { ok: true };
    }

    /**
     * POST /server/post-discord-message
     * Posts a pre-formatted embed to a channel or thread.
     * Creates the thread if threadId is null.
     * Returns { messageId, threadId }.
     */
    @Post('/post-discord-message')
    async postDiscordMessage(@Body() body: {
        channelId: string;
        threadName: string;
        threadId: string | null;
        embed: { description: string; color: string; footer?: string };
    }): Promise<object> {
        const discordClient = this.discordProvider.getClient();
        // Try cache first, fall back to fetch (forum channels may not be cached on startup)
        let channel = discordClient.channels.cache.get(body.channelId);
        if (!channel) {
            channel = await discordClient.channels.fetch(body.channelId).catch(() => null);
        }

        if (!channel) {
            throw new Error(`Channel ${body.channelId} not found`);
        }

        const embedBuilder = new EmbedBuilder()
            .setDescription(body.embed.description)
            .setColor(body.embed.color as any);
        if (body.embed.footer) embedBuilder.setFooter({ text: body.embed.footer });

        let thread: ThreadChannel;
        let messageId: string;

        console.log(`[post-discord-message] channelType=${channel.type} (GuildForum=${ChannelType.GuildForum}) threadName="${body.threadName}" threadId=${body.threadId ?? 'null'}`);

        if (channel.type === ChannelType.GuildForum) {
            // ── Forum channel: each session is a forum post ──
            // Only reuse a post if we have an explicit threadId from activeSession.
            // No name-based fallback — if activeSession was cleared, always start fresh.
            const forum = channel as ForumChannel;

            if (body.threadId) {
                console.log(`[post-discord-message] Fetching forum post by ID ${body.threadId}`);
                const fetched = await forum.threads.fetch(body.threadId).catch((err) => {
                    console.log(`[post-discord-message] Fetch by ID failed: ${err.message}`);
                    return null;
                });
                thread = fetched as ThreadChannel;
                console.log(`[post-discord-message] Found by ID: ${!!thread}`);
            }

            if (!thread) {
                console.log(`[post-discord-message] Creating new forum post "${body.threadName}"`);
                thread = await forum.threads.create({
                    name: body.threadName,
                    message: { content: 'AAR Thread' },
                }) as ThreadChannel;
                // Send the actual session embed as the first reply so the starter message stays generic
                const firstMsg = await thread.send({ embeds: [embedBuilder] });
                messageId = firstMsg.id;
                console.log(`[post-discord-message] Forum post created threadId=${thread.id} messageId=${messageId}`);
            } else {
                console.log(`[post-discord-message] Appending to existing forum post threadId=${thread.id}`);
                const msg = await thread.send({ embeds: [embedBuilder] });
                messageId = msg.id;
                console.log(`[post-discord-message] Appended messageId=${messageId}`);
            }
        } else {
            // ── Text channel: use a thread inside the channel ──
            const textChannel = channel as TextChannel;

            if (body.threadId) {
                console.log(`[post-discord-message] Fetching existing thread by ID: ${body.threadId}`);
                const fetched = await textChannel.threads.fetch(body.threadId).catch(() => null);
                thread = fetched as ThreadChannel;
            }

            if (!thread) {
                const activeThreads = await textChannel.threads.fetchActive();
                const found = activeThreads.threads.find((t) => t.name === body.threadName);
                thread = found as ThreadChannel ?? null;
            }

            if (!thread) {
                thread = await textChannel.threads.create({
                    name: body.threadName,
                    autoArchiveDuration: 1440,
                }) as ThreadChannel;
            }

            const msg = await thread.send({ embeds: [embedBuilder] });
            messageId = msg.id;
        }

        return { messageId, threadId: thread.id };
    }

    /**
     * POST /server/edit-discord-message
     * Edits an existing message in a thread.
     * If addReactions is true, also adds 👍 🆗 👎 reactions and registers the
     * message in the ratable-messages map for the reaction handler.
     */
    /**
     * POST /server/delete-message
     * Deletes a specific message from a thread.
     */
    @Post('/delete-message')
    async deleteMessage(@Body() body: {
        threadId: string;
        messageId: string;
    }): Promise<object> {
        const discordClient = this.discordProvider.getClient();
        const thread = await discordClient.channels.fetch(body.threadId) as ThreadChannel;
        if (!thread) {
            throw new Error(`Thread ${body.threadId} not found`);
        }
        const message = await thread.messages.fetch(body.messageId);
        if (!message) {
            throw new Error(`Message ${body.messageId} not found`);
        }
        await message.delete();
        return { ok: true };
    }

    /**
     * POST /server/post-to-thread
     * Posts an embed directly to an existing thread by its ID.
     * Used for AAR posts that belong to a session thread.
     */
    @Post('/post-to-thread')
    async postToThread(@Body() body: {
        threadId: string;
        embed: { description: string; color: string; footer?: string };
    }): Promise<object> {
        const discordClient = this.discordProvider.getClient();
        const thread = await discordClient.channels.fetch(body.threadId) as ThreadChannel;
        if (!thread) {
            throw new Error(`Thread ${body.threadId} not found`);
        }
        const embedBuilder = new EmbedBuilder()
            .setDescription(body.embed.description)
            .setColor(body.embed.color as any);
        if (body.embed.footer) embedBuilder.setFooter({ text: body.embed.footer });
        const msg = await thread.send({ embeds: [embedBuilder] });
        return { messageId: msg.id };
    }

    @Post('/edit-discord-message')
    async editDiscordMessage(@Body() body: {
        messageId: string;
        threadId: string;
        embed: { description: string; color: string; footer?: string };
        addReactions?: boolean;
        uniqueName?: string;
        historyEntryId?: string;
    }): Promise<object> {
        const discordClient = this.discordProvider.getClient();

        const thread = await discordClient.channels.fetch(body.threadId) as ThreadChannel;
        if (!thread) {
            throw new Error(`Thread ${body.threadId} not found`);
        }

        const embedBuilder = new EmbedBuilder()
            .setDescription(body.embed.description)
            .setColor(body.embed.color as any);
        if (body.embed.footer) embedBuilder.setFooter({ text: body.embed.footer });

        // When the outcome is set: delete the original message and post a fresh one
        // so that Discord notifies channel members who missed the original loading message
        // (outcomes are typically posted 45-60 min after the loading message).
        if (body.addReactions && body.uniqueName) {
            // Delete the original loading message (best-effort; may already be gone)
            try {
                const oldMessage = await thread.messages.fetch(body.messageId);
                await oldMessage.delete();
                console.log(`[edit-discord-message] Deleted original messageId=${body.messageId}`);
            } catch (err) {
                console.warn(`[edit-discord-message] Could not delete original message ${body.messageId}:`, err?.message);
            }

            // Post a new message in the same thread so members see it as new activity
            const newMessage = await thread.send({ embeds: [embedBuilder] });

            // Add reactions sequentially (order matters for Discord display)
            await newMessage.react('👍');
            await newMessage.react('🆗');
            await newMessage.react('👎');

            // Register the NEW message so the reaction handler can find it
            ratableMessages.set(newMessage.id, { uniqueName: body.uniqueName, historyEntryId: body.historyEntryId });
            console.log(`[edit-discord-message] Replaced messageId=${body.messageId} with newMessageId=${newMessage.id} as ratable for uniqueName=${body.uniqueName} — ratableMessages size=${ratableMessages.size}`);

            return { ok: true, newMessageId: newMessage.id };
        }

        // No outcome yet — just edit the existing message in-place (no notification needed)
        const message = await thread.messages.fetch(body.messageId);
        if (!message) {
            throw new Error(`Message ${body.messageId} not found`);
        }
        await message.edit({ embeds: [embedBuilder] });

        return { ok: true };
    }
}
