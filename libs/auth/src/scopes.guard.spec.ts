import { Test, TestingModule } from '@nestjs/testing';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Scopes, ScopesGuard, SCOPES_KEY } from './scopes.guard';

const mockContext = (user?: { scopes?: string[] }) =>
    ({
        switchToHttp: () => ({
            getRequest: () => ({ user }),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
    }) as unknown as ExecutionContext;

describe('ScopesGuard', () => {
    let guard: ScopesGuard;
    let reflector: Reflector;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [ScopesGuard, Reflector],
        }).compile();

        guard = module.get(ScopesGuard);
        reflector = module.get(Reflector);
    });

    const withRequired = (scopes: string[]) => {
        jest
            .spyOn(reflector, 'getAllAndOverride')
            .mockReturnValue(scopes);
    };

    it('allows when no scope requirement is declared', () => {
        withRequired(undefined as unknown as string[]);

        expect(guard.canActivate(mockContext(undefined))).toBe(true);
    });

    it('allows when the requirement list is empty', () => {
        withRequired([]);

        expect(guard.canActivate(mockContext(undefined))).toBe(true);
    });

    it('allows an unauthenticated request when no scopes are required', () => {
        withRequired(undefined as unknown as string[]);

        expect(guard.canActivate(mockContext(undefined))).toBe(true);
    });

    it('denies when user has no scopes and scopes are required', () => {
        withRequired(['key:write']);

        expect(() => guard.canActivate(mockContext(undefined))).toThrow(
            ForbiddenException,
        );
    });

    it('denies when user scopes do not include any required scope', () => {
        withRequired(['key:write', 'wallet:sign']);

        expect(() =>
            guard.canActivate(mockContext({ scopes: ['wallet:read'] })),
        ).toThrow(ForbiddenException);
    });

    it('denies with the insufficient_scope message', () => {
        withRequired(['key:write']);

        let message: string | undefined;
        try {
            guard.canActivate(mockContext({ scopes: ['wallet:read'] }));
        } catch (error) {
            message = (error as ForbiddenException).message;
        }
        expect(message).toBe('insufficient_scope');
    });

    it('allows when the user has an exact required scope', () => {
        withRequired(['key:write']);

        expect(guard.canActivate(mockContext({ scopes: ['key:write'] }))).toBe(
            true,
        );
    });

    it('implements OR semantics — any one matching scope is sufficient', () => {
        withRequired(['wallet:sign', 'wallet:create']);

        expect(
            guard.canActivate(mockContext({ scopes: ['wallet:sign'] })),
        ).toBe(true);
        expect(
            guard.canActivate(mockContext({ scopes: ['wallet:create'] })),
        ).toBe(true);
    });

    it('allows the wildcard * scope to satisfy any requirement', () => {
        withRequired(['wallet:sign', 'key:write']);

        expect(guard.canActivate(mockContext({ scopes: ['*'] }))).toBe(true);
    });

    it('Scopes decorator stores required scopes under SCOPES_KEY', () => {
        @Scopes('key:write', 'wallet:sign')
        class ExampleRoute { }

        expect(Reflect.getMetadata(SCOPES_KEY, ExampleRoute)).toEqual([
            'key:write',
            'wallet:sign',
        ]);
    });
});