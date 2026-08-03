import { Injectable, BadRequestException } from '@nestjs/common';
import { PolicyRepository, AuditLogRepository } from '@app/db/repositories';
import { NewPolicy, Policy } from '@app/db/schema/policies';

export interface PolicyEvaluationResult {
  decision: 'allow' | 'deny';
  reason?: string;
}

export interface TxPayload {
  to: string;
  value: string; // wei as decimal string
  chainId: number;
}

@Injectable()
export class PolicyService {
  constructor(
    private readonly policyRepo: PolicyRepository,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  async createPolicy(orgId: string, data: Omit<NewPolicy, 'org_id'>) {
    const policyData: NewPolicy = {
      ...data,
      org_id: orgId,
    };
    return this.policyRepo.create(policyData);
  }

  async listPolicies(orgId: string) {
    return this.policyRepo.findByOrgId(orgId, 'active');
  }

  async deletePolicy(orgId: string, policyId: string) {
    const policy = await this.policyRepo.findById(policyId);
    if (!policy) throw new BadRequestException('Policy not found');
    if (policy.org_id !== orgId) {
      throw new BadRequestException(
        'Policy does not belong to this organization',
      );
    }

    await this.policyRepo.update(policyId, { status: 'inactive' });

    await this.auditLogRepo.create({
      org_id: orgId,
      event: 'policy_deleted',
      status: 'success',
      metadata: {
        policyId,
        name: policy.name,
      },
    });

    return { success: true };
  }

  async evaluate(
    orgId: string,
    walletId: string,
    txPayload: TxPayload,
  ): Promise<PolicyEvaluationResult> {
    const policies = await this.policyRepo.findByOrgId(orgId, 'active');

    for (const policy of policies) {
      const result = this.evaluateRule(policy, txPayload);
      if (result.decision === 'deny') {
        // Log denied evaluation
        await this.auditLogRepo.create({
          org_id: orgId,
          wallet_id: walletId,
          event: 'policy_evaluation',
          status: 'denied',
          metadata: {
            policyId: policy.id,
            policyName: policy.name,
            ruleType: policy.rule_type,
            reason: result.reason,
            txPayload,
          },
        });

        return result;
      }
    }

    // All policies passed
    await this.auditLogRepo.create({
      org_id: orgId,
      wallet_id: walletId,
      event: 'policy_evaluation',
      status: 'allowed',
      metadata: {
        policiesChecked: policies.length,
        txPayload,
      },
    });

    return { decision: 'allow' };
  }

  private evaluateRule(
    policy: Policy,
    txPayload: TxPayload,
  ): PolicyEvaluationResult {
    const config = policy.rule_config as Record<string, unknown>;

    switch (policy.rule_type) {
      case 'address_blocklist': {
        const blocklist = config['addresses'] as string[];
        if (blocklist.includes(txPayload.to.toLowerCase())) {
          return {
            decision: 'deny',
            reason: `Recipient address ${txPayload.to} is on the blocklist`,
          };
        }
        break;
      }

      case 'address_allowlist': {
        const allowlist = config['addresses'] as string[];
        if (
          allowlist.length > 0 &&
          !allowlist.includes(txPayload.to.toLowerCase())
        ) {
          return {
            decision: 'deny',
            reason: `Recipient address ${txPayload.to} is not on the allowlist`,
          };
        }
        break;
      }

      case 'spend_limit': {
        const maxAmount = BigInt(config['max_amount_wei'] as string);
        const txValue = BigInt(txPayload.value);
        if (txValue > maxAmount) {
          return {
            decision: 'deny',
            reason: `Transaction value ${txValue} exceeds limit ${maxAmount}`,
          };
        }
        break;
      }

      case 'time_lock': {
        const now = new Date();
        const startTime = new Date(config['start_time'] as string);
        const endTime = new Date(config['end_time'] as string);
        if (now < startTime || now > endTime) {
          return {
            decision: 'deny',
            reason: `Current time is outside the allowed signing window`,
          };
        }
        break;
      }

      default:
        // Unknown rule type, allow by default
        break;
    }

    return { decision: 'allow' };
  }
}
