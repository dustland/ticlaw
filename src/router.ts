import { Channel, NewMessage } from './core/types.js';

export function stripInternalTags(text: string): string {
  return text.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
}

export function formatOutbound(rawText: string): string {
  const text = stripInternalTags(rawText);
  if (!text) return '';
  return text;
}

export function routeOutbound(
  channels: Channel[],
  jid: string,
  text: string,
  options?: { embeds?: any[] },
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendMessage(jid, text, options);
}

export function routeOutboundFile(
  channels: Channel[],
  jid: string,
  filePath: string,
  caption?: string,
): Promise<void> {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (!channel) throw new Error(`No channel for JID: ${jid}`);
  return channel.sendFile(jid, filePath, caption);
}

export function routeSetTyping(
  channels: Channel[],
  jid: string,
  isTyping: boolean,
): Promise<void> | void {
  const channel = channels.find((c) => c.ownsJid(jid) && c.isConnected());
  if (channel && channel.setTyping) {
    return channel.setTyping(jid, isTyping);
  }
}

export function findChannel(
  channels: Channel[],
  jid: string,
): Channel | undefined {
  return channels.find((c) => c.ownsJid(jid));
}
