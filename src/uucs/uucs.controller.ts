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
    const discordBanRoleId = config?.discordBanRoleId || '1526203901202927837';
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

      const targetMention = targetDiscordId ? `<@${targetDiscordId}>` : 'A user';
      const hasRule = ruleId && ruleId !== 'TIMEOUT';
      const platforms: string[] = body.platforms || [];
      const isArmaBanMsg = platforms.includes('ARMA') && !platforms.includes('DISCORD');
      const isDiscordBanMsg = platforms.includes('DISCORD') && !platforms.includes('ARMA');
      let banLocation = '';
      if (type === 'BAN' || type === 'LIFE_BAN') {
        if (isArmaBanMsg) banLocation = ' from the game server';
        else if (isDiscordBanMsg) banLocation = ' from the Discord server';
        else if (platforms.length > 0) banLocation = ' from the Discord server and game server';
      }
      const description = hasRule
        ? `${targetMention} has been ${actionText}${banLocation} for breaking Rule **${fullRule}**.\n\n**Rules & Standards:** ${websiteUrl}/rules`
        : `${targetMention} has been ${actionText}${banLocation}.`;

      const embed = new EmbedBuilder()
        .setTitle(`🛑 Infraction Issued`)
        .setDescription(description)
        .setColor(type.includes('BAN') || type === 'TIMEOUT' ? COLOR_ERROR : COLOR_OK);

      if (reason) {
        embed.addFields({ name: 'Staff Remarks', value: reason });
      }

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
          const ruleText = hasRule ? `**Rule Broken:** ${fullRule}\n` : '';
          let dmContent = `You have been ${actionWord} on Global Conflicts.\n\n${ruleText}**Reason:** ${reason || 'No reason provided'}\n**Duration:** ${durationText}.\n\nYou can review our community rules and standards here: ${websiteUrl}/rules`;
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
          const platforms: string[] = body.platforms || [];
          const isArmaBan = platforms.includes('ARMA') || platforms.includes('BOTH');
          const isDiscordBan = platforms.includes('DISCORD') || platforms.includes('BOTH');

          if (isArmaBan) {
            await targetMember.roles.add(gameBanRoleId).catch(err => console.error("Failed to add Game Ban role:", err));
          }
          if (isDiscordBan) {
            await targetMember.roles.add(discordBanRoleId).catch(err => console.error("Failed to add Banned role:", err));
          }

          // Send appeal DM
          const targetUser = targetMember.user;
          const durationText = durationMinutes ? `for ${formatDurationRaw(durationMinutes)}` : 'permanently';
          let banFromText = 'Global Conflicts';
          if (isArmaBan && !isDiscordBan) banFromText = 'the Global Conflicts game server';
          else if (isDiscordBan && !isArmaBan) banFromText = 'the Global Conflicts Discord server';
          else banFromText = 'the Global Conflicts Discord server and game server';
          const dmContent = `You have been banned ${durationText} from ${banFromText}.\n\n**Rule Broken:** ${fullRule}\n**Reason:** ${reason || 'No remarks provided'}.\n\nYou can review our community rules and standards here: ${websiteUrl}/rules\n\nYou can appeal this ban by clicking the button below.`;

          const appealButton = new ButtonBuilder()
            .setLabel('Appeal Ban')
            .setStyle(ButtonStyle.Link)
            .setURL(`${websiteUrl}/user/appeals`);
          const row = new ActionRowBuilder<ButtonBuilder>().addComponents(appealButton);
          await targetUser.send({ content: dmContent, components: [row] }).catch(() => null);
        }
      }

      const adminRoleId = process.env.DISCORD_ADMIN_ROLE_ID;
      let content: string | undefined = undefined;
      if (isTOS && adminRoleId) {
        content = targetDiscordId ? `<@${targetDiscordId}> <@&${adminRoleId}>` : `<@&${adminRoleId}>`;
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

      const targetMention = targetDiscordId ? `<@${targetDiscordId}>` : 'A user';
      const fullRule = ruleTitle ? `${ruleId}: ${ruleTitle}` : ruleId;
      const description = `${targetMention} has been ${actionText} for breaking Rule **${fullRule}**.`;

      const embed = new EmbedBuilder()
        .setTitle(`🛑 Infraction Issued`)
        .setDescription(description)
        .setColor(type.includes('BAN') ? COLOR_ERROR : COLOR_OK);

      if (reason) {
        embed.addFields({ name: 'Staff Remarks', value: reason });
      }

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

  @Post('/infraction/remove-ban-role')
  async removeBanRole(
    @Body() body: any,
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { discordId, platforms } = body;
    if (!discordId || !Array.isArray(platforms)) {
      return { ok: false, error: 'Missing discordId or platforms' };
    }

    const config = await this.db.collection('configs').findOne({});
    const gameBanRoleId = config?.gameBanRoleId || '1513121256604565605';
    const discordBanRoleId = config?.discordBanRoleId || '1526203901202927837';

    const discordClient = this.discordProvider.getClient();
    const guild = discordClient.guilds.cache.get(process.env.DISCORD_SERVER_ID);
    if (!guild) return { ok: false, error: 'Guild not found' };

    const member = await guild.members.fetch(discordId).catch(() => null);
    if (!member) return { ok: true, note: 'Member not in guild, no role to remove' };

    const isArmaBan = platforms.includes('ARMA') || platforms.includes('BOTH');
    const isDiscordBan = platforms.includes('DISCORD') || platforms.includes('BOTH');

    if (isArmaBan) {
      await member.roles.remove(gameBanRoleId).catch(err => console.error("Failed to remove Game Ban role:", err));
    }
    if (isDiscordBan) {
      await member.roles.remove(discordBanRoleId).catch(err => console.error("Failed to remove Banned role:", err));
    }

    return { ok: true };
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

      const appealButton = new ButtonBuilder()
        .setCustomId('uucs_appeal_btn')
        .setLabel(appealLabel)
        .setEmoji('📋')
        .setStyle(ButtonStyle.Secondary);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(dmButton, gmButton, adButton, appealButton);

      await channel.send({ embeds: [embed], components: [row] });
      return { ok: true };
    } catch (error: any) {
      return { ok: false, error: error.message };
    }
  }

  @Post('/message-context')
  async getMessageContext(
    @Body() body: { messageUrl: string; contextSize?: number },
    @Headers('x-api-secret') apiSecret: string,
  ): Promise<object> {
    if (!process.env.API_SECRET || apiSecret !== process.env.API_SECRET) {
      throw new UnauthorizedException('Invalid API Secret');
    }

    const { messageUrl, contextSize = 10 } = body;

    const match = messageUrl?.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
    if (!match) {
      return { ok: false, error: 'Invalid Discord message URL. Expected: https://discord.com/channels/guildId/channelId/messageId' };
    }
    const [, , channelId, messageId] = match;

    const client = this.discordProvider.getClient();
    try {
      const channel = await client.channels.fetch(channelId).catch(() => null) as TextChannel;
      if (!channel || !('messages' in channel)) {
        return { ok: false, error: 'Channel not found or not a text channel' };
      }

      const targetMsg = await channel.messages.fetch(messageId).catch(() => null);
      if (!targetMsg) return { ok: false, error: 'Message not found' };

      const before = await channel.messages.fetch({ before: messageId, limit: Math.min(Number(contextSize) || 10, 50) });

      const fmt = (msg: any) => ({
        id: msg.id,
        content: msg.content || '',
        author: {
          id: msg.author.id,
          username: msg.author.username,
          displayName: msg.member?.displayName || msg.author.displayName || msg.author.username,
          avatarUrl: msg.author.displayAvatarURL({ size: 32 }),
        },
        createdAt: msg.createdAt.toISOString(),
        attachments: msg.attachments.map((a: any) => a.url),
      });

      return {
        ok: true,
        targetMessage: fmt(targetMsg),
        contextMessages: [...before.values()]
          .map(fmt)
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()),
      };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  @Post('/appeal/resolve-thread')
  async resolveAppealThread(
    @Body() body: any,
    @Headers('x-api-secret') secret: string,
  ) {
    if (!process.env.API_SECRET || secret !== process.env.API_SECRET) {
      throw new UnauthorizedException();
    }

    const { threadId, status, staffName, canReappealAt } = body;
    if (!threadId || !status) {
      return { ok: false, error: 'Missing threadId or status' };
    }

    try {
      const discordClient = this.discordProvider.getClient();
      const thread = await discordClient.channels.fetch(threadId).catch(() => null) as any;

      if (!thread) return { ok: false, error: 'Thread not found' };

      const deniedDescription = canReappealAt
        ? `The infraction stands. Please review the community rules. A new appeal can be made on **${new Date(canReappealAt).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}**.`
        : 'The infraction stands. Please review the community rules.';

      const statusMessages: Record<string, { label: string; color: number; description: string }> = {
        APPROVED:             { label: '✅ Appeal Approved',            color: 0x2ecc71, description: 'The infraction has been voided.' },
        APPROVED_MISTAKE:     { label: '✅ Approved — Staff Mistake',   color: 0x2ecc71, description: 'The infraction has been marked as a staff error and is now ignored for escalation purposes.' },
        APPROVED_TIME_SERVED: { label: '✅ Approved — Time Served',     color: 0xf39c12, description: 'The appeal was accepted. The infraction remains on record but the ban duration has been cleared.' },
        DENIED:               { label: '❌ Appeal Denied',              color: 0xe74c3c, description: deniedDescription },
      };

      const meta = statusMessages[status] ?? { label: status, color: 0x95a5a6, description: '' };

      const embed = new EmbedBuilder()
        .setTitle(meta.label)
        .setDescription(meta.description + (staffName ? `\n\n*Resolved by ${staffName}*` : ''))
        .setColor(meta.color)
        .setTimestamp();

      await thread.send({ embeds: [embed] });
      await thread.setLocked(true, `Appeal resolved: ${status}`);
      await thread.setArchived(true, `Appeal resolved: ${status}`);

      return { ok: true };
    } catch (err: any) {
      console.error('Error resolving appeal thread:', err);
      return { ok: false, error: err.message };
    }
  }
}
