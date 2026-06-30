import { DiscordClientProvider } from '@discord-nestjs/core';
import { Body, Controller, Post, Headers, UnauthorizedException } from '@nestjs/common';
import { EmbedBuilder, TextChannel, ThreadAutoArchiveDuration, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { COLOR_ERROR, COLOR_OK } from '../helpers/colors';
import axios from 'axios';
import { InjectDb } from 'nest-mongodb';
import * as mongo from 'mongodb';

function formatDurationRaw(durationMinutes: number | null): string {
  if (durationMinutes === null || durationMinutes <= 0) {
    return 'Permanent';
  }

  const minutes = durationMinutes;

  if (minutes % 525600 === 0) {
    const years = minutes / 525600;
    return `${years} ${years === 1 ? 'Year' : 'Years'}`;
  }
  if (minutes % 43200 === 0) {
    const months = minutes / 43200;
    return `${months} ${months === 1 ? 'Month' : 'Months'}`;
  }
  if (minutes % 10080 === 0) {
    const weeks = minutes / 10080;
    return `${weeks} ${weeks === 1 ? 'Week' : 'Weeks'}`;
  }
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `${days} ${days === 1 ? 'Day' : 'Days'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'Hour' : 'Hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'Minute' : 'Minutes'}`;
}

@Controller('uucs')
export class UucsController {
  constructor(
    private readonly discordProvider: DiscordClientProvider,
    @InjectDb() private readonly db: mongo.Db,
  ) {}

  @Post('/infraction')
  async notifyInfraction(
    @Body() body: any,
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { targetDiscordId, type, ruleId, ruleTitle, reason, durationMinutes, evidenceUrls, threadUrl } = body;

    const ruleDoc = await this.db.collection('rules').findOne({ ruleId });
    const isTOS = ruleDoc?.isTOS === true || ruleId === 'G1';
    const currentRuleTitle = ruleTitle || ruleDoc?.title || '';
    const fullRule = currentRuleTitle ? `${ruleId}: ${currentRuleTitle}` : ruleId;

    const config = await this.db.collection('configs').findOne({});
    const dbWarningsChannelId = config?.warningsChannelId;
    const timeoutRoleId = config?.timeoutRoleId || '1513121726668607649';
    const spammerRoleId = config?.spammerRoleId || '1513132881097261107';
    const gameBanRoleId = config?.gameBanRoleId || '1513121256604565605';
    const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    const warningsChannelId = dbWarningsChannelId || process.env.DISCORD_WARNINGS_CHANNEL_ID || process.env.DISCORD_BOT_CHANNEL;
    const warningsChannel = guild.channels.cache.get(warningsChannelId) as TextChannel;

    if (warningsChannel) {
      let actionText = 'given an infraction';
      if (type === 'WARNING') actionText = 'warned';
      else if (type === 'TIMEOUT') actionText = 'timed out';
      else if (type === 'SPAMMER_BAN') actionText = 'banned as a spammer';
      else if (type === 'BAN') actionText = 'banned';
      else if (type === 'LIFE_BAN') actionText = 'permanently banned';
      else if (type === 'BLACKLIST') actionText = 'blacklisted';
      else if (type === 'PROBATION_FAILURE') actionText = 'placed on probation failure';

      const targetMention = targetDiscordId ? `Hi <@${targetDiscordId}>, you have` : 'A user has';
      const description = `${targetMention} been ${actionText} for breaking Rule **${fullRule}**.\n\n**Rules & Standards:** ${websiteUrl}/rules`;

      const embed = new EmbedBuilder()
        .setTitle(`🛑 Infraction Issued`)
        .setDescription(description)
        .setColor(type.includes('BAN') || type === 'TIMEOUT' ? COLOR_ERROR : COLOR_OK);

      embed.addFields({ name: 'Staff Remarks', value: reason || 'No remarks provided' });

      if (durationMinutes) {
        embed.addFields({ name: 'Duration', value: formatDurationRaw(durationMinutes), inline: true });
      }

      if (!isTOS && evidenceUrls && Array.isArray(evidenceUrls) && evidenceUrls.length > 0) {
        embed.addFields({
          name: 'Evidence',
          value: evidenceUrls.map((url: string, idx: number) => `[Evidence ${idx + 1}](${url})`).join('\n')
        });
      }

      if (threadUrl) {
        embed.addFields({ name: 'Discussion Thread', value: `[Join Thread](${threadUrl})` });
      }

      const targetMember = targetDiscordId ? await guild.members.fetch(targetDiscordId).catch(() => null) : null;

      const isBan = type === 'BAN' || type === 'LIFE_BAN';

      if (isBan && isTOS && targetDiscordId) {
        const banReason = `TOS, ${websiteUrl}/dashboard/staff/users?q=${targetDiscordId}`;
        
        // Send DM first if member is present in the guild
        if (targetMember) {
          const targetUser = targetMember.user;
          const dmContent = `You have been permanently banned from the Global Conflicts Discord server due to a TOS violation.\n\n**Rule Broken:** ${fullRule}\n**Reason:** ${reason || 'No remarks provided'}.\n\nYou can review our community rules and standards here: ${websiteUrl}/rules\n\nYou can appeal this ban by clicking the button below.`;
          
          const appealButton = new ButtonBuilder()
            .setLabel('Appeal Ban')
            .setStyle(ButtonStyle.Link)
            .setURL(`${websiteUrl}/user/appeals`);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(appealButton);
          
          await targetUser.send({ content: dmContent, components: [row] }).catch(() => null);
        }

        if (targetMember) {
          await targetMember.ban({ reason: banReason }).catch(err => console.error("Failed to natively ban member:", err));
        } else {
          await guild.bans.create(targetDiscordId, { reason: banReason }).catch(err => console.error("Failed to natively ban user ID:", err));
        }
      }

      if (targetMember) {
        const isTimeout = type === 'TIMEOUT' || (type === 'WARNING' && durationMinutes && durationMinutes > 0);
        if (isTimeout) {
          await targetMember.timeout(durationMinutes * 60 * 1000, reason || 'Timeout').catch(err => console.error("Failed to set native timeout:", err));
          
          // Send DM to target user
          const targetUser = targetMember.user;
          const actionWord = type === 'WARNING' ? 'issued a warning with a timeout' : 'timed out';
          const durationText = formatDurationRaw(durationMinutes);
          let dmContent = `You have been ${actionWord} on Global Conflicts.\n\n**Rule Broken:** ${fullRule}\n**Reason:** ${reason || 'No remarks provided'}\n**Duration:** ${durationText}.\n\nYou can review our community rules and standards here: ${websiteUrl}/rules`;
          const dmOptions: any = { content: dmContent };

          if (durationMinutes === 1440) {
            dmContent += `\n\nYou are eligible to appeal this 24-hour timeout. Click the button below to submit your appeal.`;
            const appealButton = new ButtonBuilder()
              .setLabel('Appeal Timeout')
              .setStyle(ButtonStyle.Link)
              .setURL(`${websiteUrl}/user/appeals`);
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(appealButton);
            dmOptions.content = dmContent;
            dmOptions.components = [row];
          }
          await targetUser.send(dmOptions).catch(() => null);
        } else if (type === 'SPAMMER_BAN') {
          await targetMember.roles.add(spammerRoleId).catch(err => console.error("Failed to add Spammer role:", err));
          // No appeal DM is sent to the spammer!
        } else if (isBan && !isTOS) {
          await targetMember.roles.add(gameBanRoleId).catch(err => console.error("Failed to add Game Ban role:", err));
          
          // Send appeal DM
          const targetUser = targetMember.user;
          const durationText = durationMinutes ? `for ${formatDurationRaw(durationMinutes)}` : 'permanently';
          const dmContent = `You have been banned ${durationText} from the Global Conflicts game server.\n\n**Rule Broken:** ${fullRule}\n**Reason:** ${reason || 'No remarks provided'}.\n\nYou can review our community rules and standards here: ${websiteUrl}/rules\n\nYou can appeal this ban by clicking the button below.`;
          
          const appealButton = new ButtonBuilder()
            .setLabel('Appeal Ban')
            .setStyle(ButtonStyle.Link)
            .setURL(`${websiteUrl}/user/appeals`);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(appealButton);
          await targetUser.send({ content: dmContent, components: [row] }).catch(() => null);
        }
      }

      const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
      let content = targetDiscordId ? `<@${targetDiscordId}>` : undefined;
      if (isTOS && adminRoleId) {
        content = content ? `${content} <@&${adminRoleId}>` : `<@&${adminRoleId}>`;
      }
      const sentMessage = await warningsChannel.send({ content, embeds: [embed] });
      return { ok: true, messageId: sentMessage.id, channelId: warningsChannel.id };
    }

    return { ok: false, error: 'Warnings channel not found' };
  }

  @Post('/infraction/update')
  async updateInfraction(
    @Body() body: any,
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { channelId, messageId, targetDiscordId, type, ruleId, ruleTitle, reason, durationMinutes, evidenceUrls, threadUrl } = body;
    if (!channelId || !messageId) {
      return { ok: false, error: 'Missing channelId or messageId' };
    }

    const ruleDoc = await this.db.collection('rules').findOne({ ruleId });
    const isTOS = ruleDoc?.isTOS === true || ruleId === 'G1';

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    const channel = guild.channels.cache.get(channelId) as TextChannel;
    if (!channel) return { ok: false, error: 'Channel not found' };

    try {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (!msg) return { ok: false, error: 'Message not found' };

      let actionText = 'given an infraction';
      if (type === 'WARNING') actionText = 'warned';
      else if (type === 'BAN') actionText = 'banned';
      else if (type === 'LIFE_BAN') actionText = 'permanently banned';
      else if (type === 'BLACKLIST') actionText = 'blacklisted';
      else if (type === 'PROBATION_FAILURE') actionText = 'placed on probation failure';

      const targetMention = targetDiscordId ? `Hi <@${targetDiscordId}>, you have` : 'A user has';
      const fullRule = ruleTitle ? `${ruleId}: ${ruleTitle}` : ruleId;
      const description = `${targetMention} been ${actionText} for breaking Rule **${fullRule}**.`;

      const embed = new EmbedBuilder()
        .setTitle(`🛑 Infraction Issued`)
        .setDescription(description)
        .setColor(type.includes('BAN') ? COLOR_ERROR : COLOR_OK);

      embed.addFields({ name: 'Staff Remarks', value: reason || 'No remarks provided' });

      if (durationMinutes) {
        embed.addFields({ name: 'Duration', value: `${durationMinutes / 60} Hours`, inline: true });
      }

      if (!isTOS && evidenceUrls && Array.isArray(evidenceUrls) && evidenceUrls.length > 0) {
        embed.addFields({
          name: 'Evidence',
          value: evidenceUrls.map((url: string, idx: number) => `[Evidence ${idx + 1}](${url})`).join('\n')
        });
      }

      if (threadUrl) {
        embed.addFields({ name: 'Discussion Thread', value: `[Join Thread](${threadUrl})` });
      }

      await msg.edit({ embeds: [embed] });
      return { ok: true };
    } catch (error: any) {
      console.error('Error updating Discord warning message:', error);
      return { ok: false, error: error.message };
    }
  }

  @Post('/infraction/delete')
  async deleteInfraction(
    @Body() body: any,
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { channelId, messageId } = body;
    if (!channelId || !messageId) {
      return { ok: false, error: 'Missing channelId or messageId' };
    }

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    const channel = guild.channels.cache.get(channelId) as TextChannel;
    if (!channel) return { ok: false, error: 'Channel not found' };

    try {
      const msg = await channel.messages.fetch(messageId).catch(() => null);
      if (msg) {
        await msg.delete();
      }
      return { ok: true };
    } catch (error: any) {
      console.error('Error deleting Discord warning message:', error);
      return { ok: false, error: error.message };
    }
  }

  @Post('/infraction/escalate')
  async escalateInfraction(
    @Body() body: any,
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { infractionId, targetDiscordId, ruleId, reason, staffDiscordId } = body;

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    const warningsChannelId = process.env.DISCORD_WARNINGS_CHANNEL_ID || process.env.DISCORD_BOT_CHANNEL;
    const warningsChannel = guild.channels.cache.get(warningsChannelId) as TextChannel;

    if (warningsChannel) {
      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
      const description = `⚠️ **Permanent Ban Escalation Requested**\n\n` +
        `Staff member <@${staffDiscordId}> has requested a permanent ban escalation for <@${targetDiscordId}>.\n` +
        `**Rule Broken:** ${ruleId}\n` +
        `**Temporary Infraction Remarks:** ${reason || 'No remarks provided'}`;

      const embed = new EmbedBuilder()
        .setTitle(`⚠️ Permanent Ban Escalation Requested`)
        .setDescription(description)
        .setColor(COLOR_ERROR)
        .setTimestamp()
        .addFields({ name: 'Infraction ID', value: infractionId || 'N/A', inline: true })
        .addFields({ name: 'Staff Dashboard', value: `[Go to Dashboard](${websiteUrl}/dashboard/staff/users)`, inline: true });

      const sentMessage = await warningsChannel.send({ embeds: [embed] });
      return { ok: true, messageId: sentMessage.id, channelId: warningsChannel.id };
    }

    return { ok: false, error: 'Warnings channel not found' };
  }

  @Post('/start-vote')
  async startVote(
    @Body() body: any,
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { voteId, targetDiscordId, ruleId, reason, options, expiresAt } = body;

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    const botChannelId = process.env.DISCORD_BOT_CHANNEL;
    const channel = guild.channels.cache.get(botChannelId) as TextChannel;

    if (!channel) return { ok: false, error: 'Channel not found' };

    const embed = new EmbedBuilder()
      .setTitle(`🗳️ Ban Vote Initiated`)
      .setDescription(
        `**Target:** <@${targetDiscordId}>\n` +
        `**Rule:** ${ruleId}\n` +
        `**Reason:** ${reason}\n\n` +
        `**Options:**\n${options.map((o: any, i: number) => `${i + 1}. ${o.label}`).join('\n')}\n\n` +
        `*Vote by reacting with the corresponding letter (A, B, C...)*\n` +
        `*Expires:* <t:${Math.floor(new Date(expiresAt).getTime() / 1000)}:F>`
      )
      .setColor('#2ea8ff')
      .setTimestamp()
      .setFooter({ text: `Vote ID: ${voteId}` });

    const message = await channel.send({ embeds: [embed] });

    // Add reactions (A, B, C...)
    const emojis = ['🇦', '🇧', '🇨', '🇩', '🇪', '🇫'];
    for (let i = 0; i < options.length; i++) {
      if (emojis[i]) await message.react(emojis[i]);
    }

    // Create a thread for discussion
    const thread = await message.startThread({
      name: `Vote: ${targetDiscordId} - ${ruleId}`,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });

    return { ok: true, messageId: message.id, threadId: thread.id };
  }

  @Post('/sync-members')
  async syncMembers(
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    try {
      console.log(`[UUCS] Starting member sync...`);
      const members = await guild.members.fetch();
      console.log(`[UUCS] Fetched ${members.size} members from Discord API.`);
      
      const botDiscordIds = Array.from(members.values())
        .filter(m => m.user.bot)
        .map(m => m.id);

      const memberList = Array.from(members.values()).filter(m => !m.user.bot);
      console.log(`[UUCS] Syncing ${memberList.length} non-bot members.`);

      let syncedCount = 0;
      const websiteUrl = process.env.WEBSITE_URL;
      const batchSize = 25;
      const memberRoleId = (process.env.DISCORD_MEMBER_ROLE_ID || '').trim();
      
      for (let i = 0; i < memberList.length; i += batchSize) {
        const batch = memberList.slice(i, i + batchSize).map(m => {
          const hasMemberRole = memberRoleId && m.roles.cache.has(memberRoleId);
          const hasMemberName = m.roles.cache.some(r => r.name.toLowerCase() === 'member');

          // In Discord.js v14, member.displayName automatically resolves:
          // 1. Server Nickname
          // 2. Global Display Name (globalName)
          // 3. Technical Username
          const bestNickname = m.displayName;

          return {
            discordId: m.id,
            username: m.user.username,
            nickname: bestNickname,
            displayAvatarURL: m.displayAvatarURL({ size: 128 }) || m.user.displayAvatarURL({ size: 128 }),
            isMember: !!(hasMemberRole || hasMemberName),
            discordRoles: m.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
          };
        });

        await axios.post(`${websiteUrl}/api/admin/uucs/sync-discord-batch`, 
          { members: batch },
          { headers: { 'x-api-secret': process.env.API_SECRET } }
        );
        syncedCount += batch.length;
      }

      // Cleanup existing bot profiles in the database
      if (botDiscordIds.length > 0) {
        console.log(`[UUCS] Cleaning up ${botDiscordIds.length} bot profiles...`);
        await axios.post(`${websiteUrl}/api/admin/uucs/sync-discord-batch`, 
          { members: [], botDiscordIds },
          { headers: { 'x-api-secret': process.env.API_SECRET } }
        );
      }

      console.log(`[UUCS] Sync complete. Total synced: ${syncedCount}`);
      return { ok: true, syncedCount };
    } catch (error) {
      console.error('Member Sync Error:', error);
      return { ok: false, error: error.message };
    }
  }  @Post('/message-context')
  async getMessageContext(
    @Body() body: { messageInput: string; limit?: number },
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { messageInput, limit = 10 } = body;
    if (!messageInput) return { ok: false, error: 'Missing messageInput' };

    let channelId = null;
    let messageId = null;

    const match = messageInput.match(/channels\/\d+\/(\d+)\/(\d+)/);
    if (match) {
      channelId = match[1];
      messageId = match[2];
    } else {
      messageId = messageInput.trim();
    }

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    let channel: any = null;
    let targetMsg = null;

    try {
      if (channelId) {
        channel = guild.channels.cache.get(channelId);
        if (channel && channel.isTextBased()) {
          targetMsg = await channel.messages.fetch(messageId).catch(() => null);
        }
      } else {
        for (const ch of guild.channels.cache.values()) {
          if (ch.isTextBased()) {
            targetMsg = await ch.messages.fetch(messageId).catch(() => null);
            if (targetMsg) {
              channel = ch;
              break;
            }
          }
        }
      }

      if (!targetMsg || !channel) {
        return { ok: false, error: 'Message not found in any visible text channel.' };
      }

      const limitBefore = Math.max(0, limit - 1);
      const contextMessagesCollection = limitBefore > 0
        ? await channel.messages.fetch({ limit: limitBefore, before: messageId }).catch(() => null)
        : null;

      const contextMsgs = contextMessagesCollection
        ? Array.from(contextMessagesCollection.values())
            .reverse()
            .map((msg: any) => ({
              author: msg.author.tag,
              authorId: msg.author.id,
              content: msg.content || '',
              timestamp: msg.createdAt.toISOString(),
            }))
        : [];

      return {
        ok: true,
        messageUrl: `https://discord.com/channels/${guild.id}/${channel.id}/${messageId}`,
        discordContext: {
          targetMessage: {
            author: targetMsg.author.tag,
            authorId: targetMsg.author.id,
            content: targetMsg.content || '',
            timestamp: targetMsg.createdAt.toISOString(),
          },
          contextMessages: contextMsgs,
        }
      };
    } catch (error) {
      console.error('Error fetching message context:', error);
      return { ok: false, error: error.message };
    }
  }

  @Post('/debug-roles')
  async debugRoles(
    @Body() body: { discordId: string },
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    try {
      const member = await guild.members.fetch(body.discordId);
      const user = member.user;
      const memberRoleId = (process.env.DISCORD_MEMBER_ROLE_ID || '').trim();
      
      return {
        ok: true,
        analysis: {
          guildMember_displayName: member.displayName,
          guildMember_nickname: member.nickname,
          user_username: user.username,
          // @ts-ignore
          user_globalName: user.globalName,
          // @ts-ignore
          user_global_name: (user as any).global_name,
          toString: user.toString(),
          tag: user.tag
        },
        configuredMemberRoleId: memberRoleId,
        hasConfiguredId: member.roles.cache.has(memberRoleId),
        roles: member.roles.cache.map(r => ({ id: r.id, name: r.name })),
      };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  @Post('/member')
  async getMember(
    @Body() body: { discordId: string },
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    try {
      const member = await guild.members.fetch(body.discordId).catch(() => null);
      if (!member) {
        // Fallback to fetch global user if not a member of the guild
        const user = await discordClient.users.fetch(body.discordId).catch(() => null);
        if (!user) return { ok: false, error: 'User not found in Discord' };
        return {
          ok: true,
          member: {
            discordId: user.id,
            username: user.username,
            nickname: user.username,
            displayAvatarURL: user.displayAvatarURL({ size: 128 }) || null,
            isMember: false,
            discordRoles: [],
          }
        };
      }

      const memberRoleId = (process.env.DISCORD_MEMBER_ROLE_ID || '').trim();
      const hasMemberRole = memberRoleId && member.roles.cache.has(memberRoleId);
      const hasMemberName = member.roles.cache.some(r => r.name.toLowerCase() === 'member');
      const bestNickname = member.displayName;

      return {
        ok: true,
        member: {
          discordId: member.id,
          username: member.user.username,
          nickname: bestNickname,
          displayAvatarURL: member.displayAvatarURL({ size: 128 }) || member.user.displayAvatarURL({ size: 128 }) || null,
          isMember: !!(hasMemberRole || hasMemberName),
          discordRoles: member.roles.cache.map(r => ({ id: r.id, name: r.name, color: r.hexColor })),
        }
      };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  @Post('/tickets/close-thread')
  async closeThread(
    @Body() body: { threadId: string; username: string },
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { threadId, username } = body;
    if (!threadId) return { ok: false, error: 'Missing threadId' };

    const discordClient = this.discordProvider.getClient();
    try {
      const channel = await discordClient.channels.fetch(threadId).catch(() => null);
      if (channel && channel.isThread()) {
        await channel.send({ content: `🔒 Ticket closed by **${username || 'Staff'}**.` }).catch(() => null);
        await channel.setLocked(true).catch(() => null);
        await channel.setArchived(true).catch(() => null);
        return { ok: true };
      }
      return { ok: false, error: 'Channel is not a thread or not found' };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  @Post('/tickets/merge-threads')
  async mergeThreads(
    @Body() body: { sourceThreadId: string; targetThreadId: string; openerDiscordId: string; username: string },
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { sourceThreadId, targetThreadId, openerDiscordId, username } = body;
    if (!sourceThreadId || !targetThreadId) return { ok: false, error: 'Missing sourceThreadId or targetThreadId' };

    const discordClient = this.discordProvider.getClient();
    try {
      const sourceChannel = await discordClient.channels.fetch(sourceThreadId).catch(() => null);
      const targetChannel = await discordClient.channels.fetch(targetThreadId).catch(() => null);

      if (sourceChannel && sourceChannel.isThread()) {
        const pingMention = openerDiscordId ? `<@${openerDiscordId}> ` : '';
        await sourceChannel.send({
          content: `🔒 ${pingMention}This ticket has been merged into <#${targetThreadId}> by **${username || 'Staff'}**.`
        }).catch(() => null);
        await sourceChannel.setLocked(true).catch(() => null);
        await sourceChannel.setArchived(true).catch(() => null);
      }

      if (targetChannel && targetChannel.isThread()) {
        await targetChannel.send({
          content: `ℹ️ Another ticket (<#${sourceThreadId}>) was merged into this ticket by **${username || 'Staff'}**.`
        }).catch(() => null);
      }

      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  @Post('/tickets/send-panel')
  async sendPanel(
    @Body() body: { channelId: string },
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { channelId } = body;
    if (!channelId) return { ok: false, error: 'Missing channelId' };

    const discordClient = this.discordProvider.getClient();
    try {
      const channel = await discordClient.channels.fetch(channelId).catch(() => null) as TextChannel;
      if (!channel || !channel.isTextBased()) return { ok: false, error: 'Channel not found or not text-based' };

      const config = await this.db.collection('configs').findOne({});

      const title = config?.ticketPanelTitle || 'Contact the GC Staff';
      let description = config?.ticketPanelDescription || 
        '**Discord Moderators**\nSelect this for any issues directly related to this Discord server.\n- Reporting Discord rule violations and toxic behavior.\n- Assistance with Discord roles or channel access.\n- General questions about our community.\n\n' +
        '**Arma Game Masters**\nSelect this for anything related to our Arma Reforger servers.\n- Reporting in-game rule breakers or exploiting.\n- In-game ban appeals.\n- Reporting Arma server crashes or severe performance issues.\n- General in-game support and inquiries.\nIf you need immediate in-game support, please write in the game chat to alert a GM to your ticket.\n\n' +
        '**Admin Team**\nEscalation Only. Contact the Admin team only if your issue cannot be resolved by our regular support staff. Misuse of this ticket may result in a warning. Use this only as a last resort for severe issues, community-wide problems, or high-level escalations.\n\n' +
        '**Appeals**\nLink your discord account to our website to see your infractions and options to appeal';

      // Normalize HTML bold tags to Discord Markdown
      description = description.replace(/<\/?b>/gi, '**');

      const dmLabel = config?.ticketPanelButtonDmLabel || 'Discord Moderators';
      const gmLabel = config?.ticketPanelButtonGmLabel || 'Arma Game Masters';
      const adLabel = config?.ticketPanelButtonAdLabel || 'Admin Team';
      const appealLabel = config?.ticketPanelButtonAppealLabel || 'Appeals';

      const embed = new EmbedBuilder()
        .setTitle(title)
        .setDescription(description)
        .setColor('#2ea8ff');

      const dmButton = new ButtonBuilder()
        .setCustomId('uucs_ticket_btn_dm')
        .setLabel(dmLabel)
        .setEmoji('🛡️')
        .setStyle(ButtonStyle.Secondary);

      const gmButton = new ButtonBuilder()
        .setCustomId('uucs_ticket_btn_gm')
        .setLabel(gmLabel)
        .setEmoji('🎮')
        .setStyle(ButtonStyle.Secondary);

      const adButton = new ButtonBuilder()
        .setCustomId('uucs_ticket_btn_ad')
        .setLabel(adLabel)
        .setEmoji('⚙️')
        .setStyle(ButtonStyle.Secondary);

      const websiteUrl = process.env.WEBSITE_URL || 'http://localhost:3000';
      const appealButton = new ButtonBuilder()
        .setLabel(appealLabel)
        .setEmoji('🔗')
        .setStyle(ButtonStyle.Link)
        .setURL(`${websiteUrl}/user/appeals`);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(dmButton, gmButton, adButton, appealButton);

      await channel.send({ embeds: [embed], components: [row] });
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }
}
