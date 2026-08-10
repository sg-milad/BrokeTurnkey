import { Injectable, BadRequestException } from '@nestjs/common';
import { isAddress } from 'viem';
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
      rule_config: this.validateRuleConfig(data.rule_type, data.rule_config),
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
      if (!this.appliesToWallet(policy, walletId)) continue;
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
        const blocklist = config['addresses'];
        if (!this.isAddressList(blocklist)) return this.invalidConfig(policy);
        if (blocklist.includes(txPayload.to.toLowerCase())) {
          return {
            decision: 'deny',
            reason: `Recipient address ${txPayload.to} is on the blocklist`,
          };
        }
        break;
      }

      case 'address_allowlist': {
        const allowlist = config['addresses'];
        if (!this.isAddressList(allowlist)) return this.invalidConfig(policy);
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
        const maxAmountValue = config['max_amount_wei'];
        if (
          typeof maxAmountValue !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(maxAmountValue)
        ) {
          return this.invalidConfig(policy);
        }
        const maxAmount = BigInt(maxAmountValue);
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
        if (
          typeof config['start_time'] !== 'string' ||
          typeof config['end_time'] !== 'string'
        ) {
          return this.invalidConfig(policy);
        }
        const now = new Date();
        const startTime = new Date(config['start_time']);
        const endTime = new Date(config['end_time']);
        if (
          Number.isNaN(startTime.getTime()) ||
          Number.isNaN(endTime.getTime()) ||
          startTime >= endTime
        ) {
          return this.invalidConfig(policy);
        }
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

  private appliesToWallet(policy: Policy, walletId: string): boolean {
    return (
      policy.applies_to === 'all' ||
      (policy.applies_to === 'wallet' && policy.target_id === walletId)
    );
  }

  private isAddressList(value: unknown): value is string[] {
    return (
      Array.isArray(value) &&
      value.every((address) => typeof address === 'string')
    );
  }

  private invalidConfig(policy: Policy): PolicyEvaluationResult {
    return {
      decision: 'deny',
      reason: `Policy ${policy.id} has invalid configuration`,
    };
  }

  private validateRuleConfig(
    ruleType: string,
    ruleConfig: unknown,
  ): Record<string, unknown> {
    if (
      !ruleConfig ||
      typeof ruleConfig !== 'object' ||
      Array.isArray(ruleConfig)
    ) {
      throw new BadRequestException('policy ruleConfig must be an object');
    }
    const config = ruleConfig as Record<string, unknown>;

    switch (ruleType) {
      case 'address_allowlist':
      case 'address_blocklist': {
        const addresses = config.addresses;
        if (
          !Array.isArray(addresses) ||
          !addresses.every(
            (address) => typeof address === 'string' && isAddress(address),
          )
        ) {
          throw new BadRequestException(
            'address policy ruleConfig.addresses must be an array of Ethereum addresses',
          );
        }
        return {
          addresses: (addresses as string[]).map((address) =>
            address.toLowerCase(),
          ),
        };
      }
      case 'spend_limit': {
        const maxAmount = config.max_amount_wei;
        if (
          typeof maxAmount !== 'string' ||
          !/^(0|[1-9]\d*)$/.test(maxAmount)
        ) {
          throw new BadRequestException(
            'spend_limit ruleConfig.max_amount_wei must be a non-negative decimal wei string',
          );
        }
        return { max_amount_wei: maxAmount };
      }
      case 'time_lock': {
        const start = config.start_time;
        const end = config.end_time;
        const startTime =
          typeof start === 'string' ? new Date(start) : undefined;
        const endTime = typeof end === 'string' ? new Date(end) : undefined;
        if (
          !startTime ||
          !endTime ||
          Number.isNaN(startTime.getTime()) ||
          Number.isNaN(endTime.getTime()) ||
          startTime >= endTime
        ) {
          throw new BadRequestException(
            'time_lock ruleConfig requires valid start_time and end_time values with start_time before end_time',
          );
        }
        return { start_time: start, end_time: end };
      }
      default:
        throw new BadRequestException(
          `Unsupported policy rule type: ${ruleType}`,
        );
    }
  }
}
