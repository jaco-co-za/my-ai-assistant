export function formatAddressList(list?: any[]) {
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  return list
    .map((addr) => {
      if (!addr) return null;
      const name = addr.name ? addr.name.replace(/"/g, '\\"') : null;
      if (addr.address && name) return `\"${name}\" <${addr.address}>`;
      return addr.address || name;
    })
    .filter(Boolean)
    .join(', ');
}

export function collectAttachments(bodyStructure: any, attachments: any[] = []) {
  if (!bodyStructure) return attachments;

  if (Array.isArray(bodyStructure.childNodes)) {
    for (const child of bodyStructure.childNodes) {
      collectAttachments(child, attachments);
    }
  }

  const disposition = bodyStructure.disposition?.type?.toLowerCase();
  const filename = bodyStructure.disposition?.params?.filename || bodyStructure.params?.name;
  const isAttachment = disposition === 'attachment' || disposition === 'inline';

  if (isAttachment && filename) {
    attachments.push({
      part: bodyStructure.part,
      filename,
      disposition,
      contentType: bodyStructure.type ? `${bodyStructure.type}/${bodyStructure.subtype}` : null,
      size: bodyStructure.size || null,
    });
  }

  return attachments;
}

export function chunkUids(uids: number[], size = 200) {
  const chunks: number[][] = [];
  for (let i = 0; i < uids.length; i += size) {
    chunks.push(uids.slice(i, i + size));
  }
  return chunks;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatHeaders(headersMap?: Map<string, any> | null) {
  if (!headersMap) return null;
  const lines: string[] = [];
  for (const [key, value] of headersMap) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        lines.push(`${key}: ${entry}`);
      }
    } else if (value !== undefined && value !== null) {
      lines.push(`${key}: ${value}`);
    }
  }
  return lines.length > 0 ? lines.join('\n') : null;
}
