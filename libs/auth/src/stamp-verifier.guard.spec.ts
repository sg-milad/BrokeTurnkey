import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
    createHash,
    generateKeyPairSync,
    sign,
} from 'crypto';
import {
    StampVerifierGuard,
    OptionalStampVerifierGuard,
} from './stamp-verifier.guard';
import { ApiKeyRepository } from '@app/db/repositories';

const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
});
const publicKeyPem = publicKey.export({ type: 'spki', format: 'pem' });

const mockContext = (headers: Record<string, string>, rawBody?: Buffer) =>
    ({
        switchToHttp: () => ({
            getRequest: () => ({ headers, rawBody }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
    }) as unknown as ExecutionContext;

const activeKey = {
    id: 1,
    org_id: 'org-1',
    key_id: 'key-1',
    name: 'Test Key',
    public_key: publicKeyPem,
    scopes: ['key:write'],
    status: 'active',
    created_at: new Date('2024-01-01T00:00:00Z'),
    last_used_at: null as Date | null,
    expires_at: null as Date | null,
};

const makeStamp = (body: Buffer, keyId = 'key-1') => {
    const timestamp = Date.now();
    const bodyHash = createHash('sha256').update(body).digest('base64url');
    const payload = `${timestamp}.${bodyHash}`;
    const signature = sign(
        'sha256',
        Buffer.from(payload),
        { key: privateKey, dsaEncoding: 'der' },
    );
    return {
        stamp: `${signature.toString('base64url')}.${timestamp}.${keyId}`,
        timestamp,
    };
};

describe('StampVerifierGuard', () => {
    let guard: StampVerifierGuard;
    let apiKeyRepo: jest.Mocked<Pick<ApiKeyRepository, 'findByKeyId' | 'update'>>;
    let reflector: Reflector;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StampVerifierGuard,
                {
                    provide: ApiKeyRepository,
                    useValue: {
                        findByKeyId: jest.fn(),
                        update: jest.fn().mockResolvedValue(undefined),
                        hasScope: jest.fn(),
                        create: jest.fn(),
                        findByOrgId: jest.fn(),
                    },
                },
                Reflector,
            ],
        }).compile();

        guard = module.get(StampVerifierGuard);
        apiKeyRepo = module.get(ApiKeyRepository);
        reflector = module.get(Reflector);

        jest
            .spyOn(reflector, 'getAllAndOverride')
            .mockReturnValue(undefined);
    });

    it('allows public routes without any stamp validation', async () => {
        jest
            .spyOn(reflector, 'getAllAndOverride')
            .mockReturnValue(true);

        await expect(
            guard.canActivate(mockContext({})),
        ).resolves.toBe(true);
        expect(apiKeyRepo.findByKeyId).not.toHaveBeenCalled();
    });

    it('rejects when the X-Stamp header is missing', async () => {
        await expect(
            guard.canActivate(mockContext({})),
        ).rejects.toThrow('Missing X-Stamp header');
    });

    it('rejects a malformed stamp format', async () => {
        await expect(
            guard.canActivate(mockContext({ 'x-stamp': 'a.b.c.d' })),
        ).rejects.toThrow('Invalid stamp format');
        await expect(
            guard.canActivate(mockContext({ 'x-stamp': 'a.b' })),
        ).rejects.toThrow('Invalid stamp format');
    });

    it('rejects a non-numeric timestamp', async () => {
        await expect(
            guard.canActivate(
                mockContext({ 'x-stamp': 'sig.notanumber.key-1' }),
            ),
        ).rejects.toThrow('Invalid timestamp in stamp');
    });

    it('rejects a timestamp older than 5 minutes', async () => {
        const old = Date.now() - 6 * 60 * 1000;
        await expect(
            guard.canActivate(
                mockContext({ 'x-stamp': `sig.${old}.key-1` }),
            ),
        ).rejects.toThrow('Stamp timestamp is out of valid range');
    });

    it('rejects a timestamp more than 30 seconds in the future', async () => {
        const future = Date.now() + 60 * 1000;
        await expect(
            guard.canActivate(
                mockContext({ 'x-stamp': `sig.${future}.key-1` }),
            ),
        ).rejects.toThrow('Stamp timestamp is out of valid range');
    });

    it('rejects when the API key is not found', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue(undefined);

        const { stamp } = makeStamp(Buffer.from(''));
        await expect(
            guard.canActivate(mockContext({ 'x-stamp': stamp })),
        ).rejects.toThrow('API key not found');
    });

    it('rejects when the API key is not active', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue({
            ...activeKey,
            status: 'revoked',
        });

        const { stamp } = makeStamp(Buffer.from(''));
        await expect(
            guard.canActivate(mockContext({ 'x-stamp': stamp })),
        ).rejects.toThrow('API key is not active');
    });

    it('rejects when the API key has expired', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue({
            ...activeKey,
            expires_at: new Date(Date.now() - 1000),
        });

        const { stamp } = makeStamp(Buffer.from(''));
        await expect(
            guard.canActivate(mockContext({ 'x-stamp': stamp })),
        ).rejects.toThrow('API key has expired');
    });

    it('rejects a signature of invalid length', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue(activeKey);

        const signature = Buffer.alloc(10, 1).toString('base64url');
        const timestamp = Date.now();
        await expect(
            guard.canActivate(
                mockContext({
                    'x-stamp': `${signature}.${timestamp}.key-1`,
                }),
            ),
        ).rejects.toThrow('Invalid signature length');
    });

    it('rejects a valid-length but incorrect signature', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue(activeKey);

        const { stamp } = makeStamp(Buffer.from('some-body'));
        await expect(
            guard.canActivate(mockContext({ 'x-stamp': stamp })),
        ).rejects.toThrow('Invalid signature');
    });

    it('rejects when verify throws (malformed public key)', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue({
            ...activeKey,
            public_key: 'not-a-pem-key',
        });

        const { stamp } = makeStamp(Buffer.from(''));
        await expect(
            guard.canActivate(mockContext({ 'x-stamp': stamp })),
        ).rejects.toThrow('Invalid signature');
    });

    it('attaches the user and updates last_used_at on a valid stamp', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue(activeKey);

        const body = Buffer.from(JSON.stringify({ hello: 'world' }));
        const { stamp } = makeStamp(body);
        const request: Record<string, any> = {
            headers: { 'x-stamp': stamp },
            rawBody: body,
        };
        const context = {
            switchToHttp: () => ({
                getRequest: () => request,
            }),
            getHandler: () => ({}),
            getClass: () => ({}),
        } as unknown as ExecutionContext;

        await expect(guard.canActivate(context)).resolves.toBe(true);

        expect(request.user).toEqual({
            orgId: 'org-1',
            apiKeyId: 1,
            keyId: 'key-1',
            scopes: ['key:write'],
        });
        expect(apiKeyRepo.update).toHaveBeenCalledWith(
            1,
            expect.objectContaining({ last_used_at: expect.any(Date) }),
        );
    });

    it('does not block the request when the last_used_at update fails', async () => {
        apiKeyRepo.findByKeyId.mockResolvedValue(activeKey);
        apiKeyRepo.update.mockRejectedValue(new Error('db down'));

        const body = Buffer.from(JSON.stringify({ hello: 'world' }));
        const { stamp } = makeStamp(body);
        const request: Record<string, any> = {
            headers: { 'x-stamp': stamp },
            rawBody: body,
        };
        const context = {
            switchToHttp: () => ({
                getRequest: () => request,
            }),
            getHandler: () => ({}),
            getClass: () => ({}),
        } as unknown as ExecutionContext;

        await expect(guard.canActivate(context)).resolves.toBe(true);
    });
});

describe('OptionalStampVerifierGuard', () => {
    let optional: OptionalStampVerifierGuard;
    let stampVerifier: StampVerifierGuard;
    let reflector: Reflector;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StampVerifierGuard,
                OptionalStampVerifierGuard,
                {
                    provide: ApiKeyRepository,
                    useValue: {
                        findByKeyId: jest.fn(),
                        update: jest.fn().mockResolvedValue(undefined),
                    },
                },
                Reflector,
            ],
        }).compile();

        optional = module.get(OptionalStampVerifierGuard);
        stampVerifier = module.get(StampVerifierGuard);
        reflector = module.get(Reflector);

        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    });

    it('returns true on public routes', async () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

        await expect(optional.canActivate(mockContext({}))).resolves.toBe(true);
    });

    it('returns true without validation when no stamp is present', async () => {
        const spy = jest.spyOn(stampVerifier, 'canActivate');

        await expect(optional.canActivate(mockContext({}))).resolves.toBe(true);
        expect(spy).not.toHaveBeenCalled();
    });

    it('delegates to StampVerifierGuard when a stamp is present', async () => {
        const spy = jest
            .spyOn(stampVerifier, 'canActivate')
            .mockResolvedValue(true);

        await expect(
            optional.canActivate(mockContext({ 'x-stamp': 'anything' })),
        ).resolves.toBe(true);
        expect(spy).toHaveBeenCalledTimes(1);
    });
});