import { Test } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { PolicyService } from './policy.service';
import { PolicyRepository, AuditLogRepository } from '@app/db/repositories';
import { Policy } from '@app/db/schema/policies';

describe('PolicyService', () => {
  let service: PolicyService;
  let policyRepo: Record<string, jest.Mock>;
  let auditLogRepo: Record<string, jest.Mock>;

  const activePolicy = (
    id: string,
    ruleType: string,
    ruleConfig: Record<string, unknown>,
  ): Policy =>
    ({
      id,
      org_id: 'org-1',
      name: `policy-${id}`,
      rule_type: ruleType,
      rule_config: ruleConfig,
      applies_to: 'all',
      target_id: null,
      status: 'active',
      created_at: new Date('2024-01-01T00:00:00Z'),
      updated_at: new Date('2024-01-01T00:00:00Z'),
    }) as Policy;

  beforeEach(async () => {
    policyRepo = {
      create: jest.fn(),
      findByOrgId: jest.fn(),
      findById: jest.fn(),
      update: jest.fn(),
    };
    auditLogRepo = { create: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        PolicyService,
        { provide: PolicyRepository, useValue: policyRepo },
        { provide: AuditLogRepository, useValue: auditLogRepo },
      ],
    }).compile();

    service = module.get(PolicyService);
  });

  describe('createPolicy', () => {
    it('adds orgId and delegates to repository', async () => {
      const data = {
        name: 'Blocklist',
        rule_type: 'spend_limit',
        rule_config: { max_amount_wei: '1' },
      };
      const created = { ...data, org_id: 'org-1' };
      policyRepo.create.mockResolvedValue(created);

      await expect(service.createPolicy('org-1', data as any)).resolves.toEqual(
        created,
      );
      expect(policyRepo.create).toHaveBeenCalledWith({
        ...data,
        org_id: 'org-1',
      });
    });
  });

  describe('listPolicies', () => {
    it('lists only active policies for the org', async () => {
      const policies = [activePolicy('p-1', 'spend_limit', {})];
      policyRepo.findByOrgId.mockResolvedValue(policies);

      await expect(service.listPolicies('org-1')).resolves.toEqual(policies);
      expect(policyRepo.findByOrgId).toHaveBeenCalledWith('org-1', 'active');
    });
  });

  describe('deletePolicy', () => {
    it('throws BadRequestException when policy not found', async () => {
      policyRepo.findById.mockResolvedValue(undefined);

      await expect(service.deletePolicy('org-1', 'p-1')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.deletePolicy('org-1', 'p-1')).rejects.toThrow(
        'Policy not found',
      );
      expect(policyRepo.update).not.toHaveBeenCalled();
      expect(auditLogRepo.create).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when policy belongs to another org', async () => {
      const policy = activePolicy('p-2', 'spend_limit', {});
      policy.org_id = 'org-2';
      policyRepo.findById.mockResolvedValue(policy);

      await expect(service.deletePolicy('org-1', 'p-2')).rejects.toThrow(
        BadRequestException,
      );
      await expect(service.deletePolicy('org-1', 'p-2')).rejects.toThrow(
        'Policy does not belong to this organization',
      );
      expect(policyRepo.update).not.toHaveBeenCalled();
      expect(auditLogRepo.create).not.toHaveBeenCalled();
    });

    it('deactivates policy and writes audit log', async () => {
      const policy = activePolicy('p-3', 'spend_limit', {});
      policyRepo.findById.mockResolvedValue(policy);
      policyRepo.update.mockResolvedValue({ ...policy, status: 'inactive' });
      auditLogRepo.create.mockResolvedValue({});

      await expect(service.deletePolicy('org-1', 'p-3')).resolves.toEqual({
        success: true,
      });

      expect(policyRepo.update).toHaveBeenCalledWith('p-3', {
        status: 'inactive',
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith({
        org_id: 'org-1',
        event: 'policy_deleted',
        status: 'success',
        metadata: { policyId: 'p-3', name: 'policy-p-3' },
      });
    });
  });

  describe('evaluate', () => {
    const tx = { to: '0xabc', value: '1000', chainId: 1 };

    it('skips a wallet-targeted policy for a different wallet', async () => {
      const policy = activePolicy('p-target', 'address_blocklist', {
        addresses: ['0xabc'],
      });
      policy.applies_to = 'wallet';
      policy.target_id = 'w-target';
      policyRepo.findByOrgId.mockResolvedValue([policy]);

      await expect(service.evaluate('org-1', 'w-other', tx)).resolves.toEqual({
        decision: 'allow',
      });
    });

    it('denies when recipient is on the address blocklist', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-1', 'address_blocklist', {
          addresses: ['0xabc'],
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'deny',
        reason: 'Recipient address 0xabc is on the blocklist',
      });

      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          org_id: 'org-1',
          wallet_id: 'w-1',
          event: 'policy_evaluation',
          status: 'denied',
        }),
      );
    });

    it('allows when recipient is not on the blocklist', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-1', 'address_blocklist', {
          addresses: ['0xdef'],
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'allow',
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'allowed',
          metadata: expect.objectContaining({ policiesChecked: 1 }),
        }),
      );
    });

    it('denies when recipient is not on the address allowlist', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-2', 'address_allowlist', {
          addresses: ['0xdef'],
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'deny',
        reason: 'Recipient address 0xabc is not on the allowlist',
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'denied' }),
      );
    });

    it('allows when recipient is on the address allowlist', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-2', 'address_allowlist', {
          addresses: ['0xabc'],
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'allow',
      });
    });

    it('denies when tx value exceeds spend limit', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-3', 'spend_limit', {
          max_amount_wei: '500',
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'deny',
        reason: 'Transaction value 1000 exceeds limit 500',
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'denied' }),
      );
    });

    it('allows when tx value is within spend limit', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-3', 'spend_limit', {
          max_amount_wei: '5000',
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'allow',
      });
    });

    it('denies when current time is outside the time_lock window', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-06-01T12:00:00Z'));

      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-4', 'time_lock', {
          start_time: '2024-07-01T00:00:00.000Z',
          end_time: '2024-08-01T00:00:00.000Z',
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'deny',
        reason: 'Current time is outside the allowed signing window',
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'denied' }),
      );

      jest.useRealTimers();
    });

    it('allows when current time is inside the time_lock window', async () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2024-07-15T12:00:00Z'));

      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-4', 'time_lock', {
          start_time: '2024-07-01T00:00:00.000Z',
          end_time: '2024-08-01T00:00:00.000Z',
        }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'allow',
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'allowed' }),
      );

      jest.useRealTimers();
    });

    it('returns first deny and stops evaluating remaining policies', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-1', 'address_blocklist', {
          addresses: ['0xabc'],
        }),
        activePolicy('p-3', 'spend_limit', { max_amount_wei: '500' }),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'deny',
        reason: 'Recipient address 0xabc is on the blocklist',
      });
      expect(auditLogRepo.create).toHaveBeenCalledTimes(1);
    });

    it('falls through unknown rule types and allows', async () => {
      policyRepo.findByOrgId.mockResolvedValue([
        activePolicy('p-5', 'custom_rule', {}),
      ]);

      await expect(service.evaluate('org-1', 'w-1', tx)).resolves.toEqual({
        decision: 'allow',
      });
      expect(auditLogRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'allowed' }),
      );
    });
  });
});
