import { Injectable } from '@nestjs/common';
import { On, InjectDiscordClient } from '@discord-nestjs/core';
import { Client, MessageReaction, User } from 'discord.js';
import axios from 'axios';
import { ratableMessages } from '../../server/server.controller';

const VALID_EMOJIS: Record<string, string> = {
    '👍': 'positive',
    '🆗': 'neutral',
    '👎': 'negative',
};

@Injectable()
export class ReactionHandler {
    constructor(@InjectDiscordClient() private readonly client: Client) { }

    @On('messageReactionAdd')
    async onReactionAdd(reaction: MessageReaction, user: User): Promise<void> {
        console.log(`[ReactionHandler] messageReactionAdd fired — messageId=${reaction.message.id} emoji=${reaction.emoji.name} userId=${user.id} partial=${reaction.partial}`);

        // Resolve partials (can happen after bot restart)
        if (reaction.partial) {
            try {
                await reaction.fetch();
                console.log(`[ReactionHandler] Partial reaction resolved OK`);
            } catch (err) {
                console.error(`[ReactionHandler] Failed to resolve partial reaction:`, err?.message);
                return;
            }
        }
        if (user.partial) {
            try {
                await user.fetch();
                console.log(`[ReactionHandler] Partial user resolved OK`);
            } catch (err) {
                console.error(`[ReactionHandler] Failed to resolve partial user:`, err?.message);
                return;
            }
        }

        // Ignore bot reactions
        if (user.bot) {
            console.log(`[ReactionHandler] Ignoring bot reaction from ${user.id}`);
            return;
        }

        // Only handle tracked messages
        const tracked = ratableMessages.get(reaction.message.id);
        console.log(`[ReactionHandler] ratableMessages size=${ratableMessages.size} keys=[${[...ratableMessages.keys()].join(', ')}]`);
        if (!tracked) {
            console.log(`[ReactionHandler] messageId=${reaction.message.id} is NOT in ratableMessages — ignoring`);
            return;
        }
        console.log(`[ReactionHandler] Message is tracked → uniqueName=${tracked.uniqueName}`);

        // Only handle the three rating emojis
        const emoji = reaction.emoji.name;
        const ratingValue = VALID_EMOJIS[emoji];
        console.log(`[ReactionHandler] emoji="${emoji}" ratingValue=${ratingValue ?? '(none — not a rating emoji)'}`);
        if (!ratingValue) {
            // Remove non-rating reactions silently
            await reaction.users.remove(user.id).catch(() => null);
            return;
        }

        // Role check — must have a role named "Member"
        try {
            const guild = reaction.message.guild;
            if (!guild) {
                console.log(`[ReactionHandler] No guild on message — aborting`);
                return;
            }
            const member = await guild.members.fetch(user.id);
            const roles = member.roles.cache.map((r) => r.name);
            console.log(`[ReactionHandler] User ${user.id} roles: [${roles.join(', ')}]`);
            const isMember = member.roles.cache.some((r) => r.name === 'Member');
            if (!isMember) {
                console.log(`[ReactionHandler] User ${user.id} does NOT have "Member" role — removing reaction`);
                await reaction.users.remove(user.id).catch(() => null);
                return;
            }
            console.log(`[ReactionHandler] Role check passed`);
        } catch (err) {
            console.error(`[ReactionHandler] Role check error:`, err?.message);
            return;
        }

        // Remove the user's existing reactions for the other two emojis (one vote per user)
        const otherEmojis = Object.keys(VALID_EMOJIS).filter((e) => e !== emoji);
        for (const otherEmoji of otherEmojis) {
            const existing = reaction.message.reactions.cache.get(otherEmoji);
            if (existing) {
                await existing.users.remove(user.id).catch(() => null);
            }
        }

        // Forward the rating to the website
        const websiteUrl = process.env.WEBSITE_URL ?? 'http://globalconflicts.net';
        const url = `${websiteUrl}/api/reforger-missions/${tracked.uniqueName}/rate_mission`;
        console.log(`[ReactionHandler] Posting rating to ${url} — value=${ratingValue} discordUserId=${user.id} historyEntryId=${tracked.historyEntryId}`);
        try {
            const resp = await axios.post(
                url,
                { value: ratingValue, discordUserId: user.id, historyEntryId: tracked.historyEntryId },
                {
                    headers: { 'x-api-secret': process.env.API_SECRET },
                    timeout: 5000,
                }
            );
            console.log(`[ReactionHandler] Rating posted OK — status=${resp.status}`);
        } catch (err) {
            console.error(`[ReactionHandler] Failed to post rating — status=${err?.response?.status} body=${JSON.stringify(err?.response?.data)} message=${err?.message}`);
        }

        // Remove the user's own reaction after recording it.
        // This keeps the reaction counts at zero so future voters are not swayed
        // by seeing which option others chose.
        await reaction.users.remove(user.id).catch(() => null);
        console.log(`[ReactionHandler] Removed reaction ${emoji} from user ${user.id} to preserve voting neutrality`);
    }
}
