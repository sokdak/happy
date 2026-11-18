import type { ContentBlock } from '@agentclientprotocol/sdk';
import type { PendingAttachment } from '@/utils/MessageQueue2';

/** Validate decrypted bytes before sending a standard ACP image block. */
export function acpPromptImages(attachments: PendingAttachment[]): ContentBlock[] {
    return attachments.map(({ data }) => {
        if (data.length > 10 * 1024 * 1024) throw new Error('ACP image exceeds 10 MiB');
        const bytes = Buffer.from(data);
        let mimeType: string;
        if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) mimeType = 'image/png';
        else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mimeType = 'image/jpeg';
        else if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) mimeType = 'image/gif';
        else if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') mimeType = 'image/webp';
        else throw new Error('ACP attachment is not a supported PNG, JPEG, GIF or WebP image');
        return { type: 'image', mimeType, data: bytes.toString('base64') };
    });
}
