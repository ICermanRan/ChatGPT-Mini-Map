(() => {
  'use strict';

  // Pure parser: keep the current branch only, including messages absent from the DOM.
  // ChatGPT's website response is an internal format and can change independently.
  const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

  function contentKind(part) {
    return String(part?.content_type || part?.type || part?.mime_type || '').toLowerCase();
  }

  function readablePart(part, depth = 0) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object' || depth > 20) return '';
    const kind = String(part.content_type || part.type || '').toLowerCase();
    if (Array.isArray(part.parts)) return part.parts.map(item => readablePart(item, depth + 1)).filter(Boolean).join('\n');
    if (typeof part.text === 'string') return part.text;
    if (typeof part.transcription === 'string') return part.transcription;
    if (typeof part.transcript === 'string') return part.transcript;
    if (part.text && typeof part.text === 'object') return readablePart(part.text, depth + 1);
    if (/image/.test(kind)) return '[图片]';
    if (/audio/.test(kind)) return '[音频]';
    if (/video/.test(kind)) return '[视频]';
    if (/file/.test(kind)) return `[文件${part.name || part.filename ? `：${part.name || part.filename}` : ''}]`;
    return kind ? `[${kind} 内容]` : '';
  }

  // The API content can contain image/file objects beside the actual question.
  // Keep those objects in the display text, but never use their synthesized
  // labels as the only body anchor for a question that also has real text.
  function bodyPart(part, depth = 0) {
    if (typeof part === 'string') return part;
    if (!part || typeof part !== 'object' || depth > 20) return '';
    if (Array.isArray(part.parts)) return part.parts.map(item => bodyPart(item, depth + 1)).filter(Boolean).join('\n');
    for (const key of ['text', 'transcription', 'transcript']) {
      if (typeof part[key] === 'string') return part[key];
      if (part[key] && typeof part[key] === 'object') return bodyPart(part[key], depth + 1);
    }
    return '';
  }

  function attachmentInfo(message) {
    const output = [];
    const add = value => {
      if (!value || typeof value !== 'object') return;
      const kind = contentKind(value).replace(/^application\//, '');
      const name = value.name || value.filename || value.file_name;
      const item = {kind: kind || 'attachment'};
      if (typeof name === 'string' && name.trim()) item.name = name.trim().slice(0, 240);
      const key = `${item.kind}:${item.name || ''}`;
      if (!output.some(old => `${old.kind}:${old.name || ''}` === key)) output.push(item);
    };
    for (const item of Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments : []) add(item);
    const parts = message?.content?.parts;
    if (Array.isArray(parts)) for (const part of parts) if (part && typeof part === 'object') add(part);
    return output;
  }

  function messageText(message) {
    const text = readablePart(message.content);
    const attachments = Array.isArray(message.metadata?.attachments) ? message.metadata.attachments : [];
    const labels = attachments.map(item => {
      const name = item?.name || item?.filename;
      return typeof name === 'string' && name ? `[附件：${name}]` : '[附件]';
    });
    return [text, ...labels].filter(Boolean).join('\n').trim();
  }

  function headingLabel(value) {
    return value.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~]/g, '').replace(/\\([\\`*_{}\[\]()#+.!>-])/g, '$1').trim();
  }

  function parseHeadings(text, messageId = '') {
    const headings = [];
    const lines = String(text).split(/\r?\n/);
    let fence = null;
    let previous = '';
    for (const line of lines) {
      const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
      if (fence) {
        if (fenceMatch && fenceMatch[1][0] === fence.character && fenceMatch[1].length >= fence.length && !fenceMatch[2].trim()) fence = null;
        previous = '';
        continue;
      }
      if (fenceMatch) {
        fence = {character: fenceMatch[1][0], length: fenceMatch[1].length};
        previous = '';
        continue;
      }
      const atx = line.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
      const setext = line.match(/^ {0,3}(=+|-+)\s*$/);
      let level = 0;
      let label = '';
      if (atx) {
        level = atx[1].length;
        label = headingLabel(atx[2].replace(/[ \t]+#+[ \t]*$/, ''));
      } else if (setext && previous.trim() && !/^ {4}|^\t|^\s*(?:>|[-+*] |\d+[.)] )/.test(previous)) {
        level = setext[1][0] === '=' ? 1 : 2;
        label = headingLabel(previous);
      }
      if (level && label) headings.push({id: `${messageId}:heading:${headings.length}`, level, text: label, index: headings.length});
      previous = atx || setext ? '' : line;
    }
    return headings;
  }

  function isVisible(message) {
    const role = message?.author?.role;
    if (role !== 'user' && role !== 'assistant') return false;
    const metadata = message.metadata || {};
    if (metadata.is_visually_hidden_from_conversation || metadata.is_hidden || metadata.hidden || metadata.is_user_system_message || message.is_hidden) return false;
    if (metadata.visibility === 'hidden' || metadata.visibility === false) return false;
    if (['user_editable_context', 'thoughts', 'reasoning_recap'].includes(message.content?.content_type)) return false;
    if (role === 'assistant') {
      const channel = message.channel || metadata.channel;
      if (channel && channel !== 'final' && channel !== 'commentary') return false;
      if (message.recipient && message.recipient !== 'all') return false;
    }
    return true;
  }

  function parseConversation(data) {
    if (!data || typeof data !== 'object' || !data.mapping || typeof data.mapping !== 'object' || Array.isArray(data.mapping)) {
      throw new Error('会话数据格式不兼容，无法确认已读取完整对话。');
    }
    const mapping = data.mapping;
    const currentNode = data.current_node;
    if (typeof currentNode !== 'string' || !own(mapping, currentNode)) {
      throw new Error('未找到当前对话分支，无法确认已读取完整对话。');
    }
    const branch = [];
    const visited = new Set();
    let nodeId = currentNode;
    while (nodeId !== null && nodeId !== undefined) {
      if (typeof nodeId !== 'string' || visited.has(nodeId) || !own(mapping, nodeId) || !mapping[nodeId] || typeof mapping[nodeId] !== 'object') {
        throw new Error('对话分支数据不完整，请重新读取。');
      }
      visited.add(nodeId);
      const node = mapping[nodeId];
      if (!own(node, 'parent') || (node.parent !== null && typeof node.parent !== 'string')) {
        throw new Error('对话分支数据不完整，请重新读取。');
      }
      branch.push({nodeId, message: node.message});
      nodeId = node.parent;
    }
    const messages = [];
    const messageIds = new Set();
    for (const entry of branch.reverse()) {
      const message = entry.message;
      if (!isVisible(message)) continue;
      const id = typeof message.id === 'string' && message.id ? message.id : entry.nodeId;
      if (messageIds.has(id)) continue;
      messageIds.add(id);
      let text = messageText(message);
      if (!text && message.status === 'in_progress') text = '（回答生成中）';
      if (!text) continue;
      const bodyText = bodyPart(message.content).replace(/\u200B/g, '').trim();
      const attachments = attachmentInfo(message);
      const matchTexts = [bodyText, text].filter((value, index, values) => value && values.indexOf(value) === index);
      messages.push({id, nodeId: entry.nodeId, role: message.author.role, text, bodyText, matchTexts, attachments,
        headings: parseHeadings(text, id),
        createTime: typeof message.create_time === 'number' ? message.create_time : null,
        status: typeof message.status === 'string' ? message.status : ''});
    }
    return {messages, currentNode};
  }

  globalThis.CGMapModel = Object.freeze({parseConversation, parseHeadings});
})();
