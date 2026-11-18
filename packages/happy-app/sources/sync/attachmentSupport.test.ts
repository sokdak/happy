import { describe, expect, it } from 'vitest';

import {
    getImageAttachmentSendPlan,
    isAttachmentAllowedByPolicy,
    supportsImageAttachmentsForFlavor,
} from './attachmentSupport';

describe('supportsImageAttachmentsForFlavor', () => {
    it('honors a false AGY image capability for the picker and preserves the whole unsent prompt', () => {
        expect(supportsImageAttachmentsForFlavor('agy', null, false)).toBe(false);
        expect(getImageAttachmentSendPlan({ flavor: 'agy', agyImageInput: false, text: 'Describe this image', attachmentCount: 1 }))
            .toMatchObject({ shouldShowUnsupportedAlert: true, shouldUseAttachments: false, shouldSendText: false });
        expect(getImageAttachmentSendPlan({ flavor: 'agy', agyImageInput: false, text: 'Hello', attachmentCount: 0 }).shouldSendText).toBe(true);
    });

    it('admits DeepSeek Flash images and refuses Pro image-only sends', () => {
        expect(supportsImageAttachmentsForFlavor('deepseek', 'deepseek-flash')).toBe(true);
        expect(supportsImageAttachmentsForFlavor('deepseek', 'deepseek-v4-pro')).toBe(false);
        expect(getImageAttachmentSendPlan({ flavor: 'deepseek', model: 'deepseek-v4-pro', text: '', attachmentCount: 1 }))
            .toMatchObject({ shouldUseAttachments: false, shouldShowUnsupportedAlert: true, shouldSendText: false });
    });
    it('supports legacy sessions, Claude, Codex, and Antigravity', () => {
        expect(supportsImageAttachmentsForFlavor(undefined)).toBe(true);
        expect(supportsImageAttachmentsForFlavor(null)).toBe(true);
        expect(supportsImageAttachmentsForFlavor('claude')).toBe(true);
        expect(supportsImageAttachmentsForFlavor('codex')).toBe(true);
        expect(supportsImageAttachmentsForFlavor('agy')).toBe(true);
    });

    it('rejects Gemini, OpenClaw, and unknown explicit flavors', () => {
        expect(supportsImageAttachmentsForFlavor('gemini')).toBe(false);
        expect(supportsImageAttachmentsForFlavor('openclaw')).toBe(false);
        expect(supportsImageAttachmentsForFlavor('custom-agent')).toBe(false);
    });
});

describe('getImageAttachmentSendPlan', () => {
    it('uses attachments and sends text for Codex', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'codex',
            text: '',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: true,
            shouldUseAttachments: true,
            shouldShowUnsupportedAlert: false,
            shouldSendText: true,
        });
    });

    it('uses attachments and sends text for Antigravity', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'agy',
            text: '',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: true,
            shouldUseAttachments: true,
            shouldShowUnsupportedAlert: false,
            shouldSendText: true,
        });
    });

    it('warns but still sends non-empty text for unsupported agents', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'gemini',
            text: 'describe this',
            attachmentCount: 1,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: true,
        });
    });

    it('warns and sends nothing for unsupported image-only messages', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'openclaw',
            text: '   ',
            attachmentCount: 2,
        })).toEqual({
            supportsAttachments: false,
            shouldUseAttachments: false,
            shouldShowUnsupportedAlert: true,
            shouldSendText: false,
        });
    });
});

describe('Rig attachment policy', () => {
    it('lets capability metadata override provider flavor inference', () => {
        expect(getImageAttachmentSendPlan({
            flavor: 'custom',
            text: '',
            attachmentCount: 1,
            supportsAttachments: true,
        }).shouldUseAttachments).toBe(true);
    });

    it('honors media type wildcards and max bytes', () => {
        const policy = { maxBytes: 10, mediaTypes: ['image/*'] };
        expect(isAttachmentAllowedByPolicy({ mimeType: 'image/png', size: 10 }, policy)).toBe(true);
        expect(isAttachmentAllowedByPolicy({ mimeType: 'image/png', size: 11 }, policy)).toBe(false);
        expect(isAttachmentAllowedByPolicy({ mimeType: 'application/pdf', size: 5 }, policy)).toBe(false);
    });
});
