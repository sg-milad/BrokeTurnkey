import {
  Injectable,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { UserRepository, AuditLogRepository } from '@app/db/repositories';
import { NewUser } from '@app/db/schema/users';

export interface CreateUserDto {
  externalId: string;
  email?: string;
  role?: string;
}

@Injectable()
export class UserService {
  constructor(
    private readonly userRepo: UserRepository,
    private readonly auditLogRepo: AuditLogRepository,
  ) {}

  async createUser(orgId: string, data: CreateUserDto) {
    // Check if user already exists for this org
    const existing = await this.userRepo.findByOrgAndExternalId(
      orgId,
      data.externalId,
    );
    if (existing) {
      throw new BadRequestException(
        `User with external_id ${data.externalId} already exists in this organization`,
      );
    }

    const userData: NewUser = {
      org_id: orgId,
      external_id: data.externalId,
      email: data.email || null,
      role: data.role || 'member',
      status: 'active',
    };

    const user = await this.userRepo.create(userData);

    await this.auditLogRepo.create({
      org_id: orgId,
      user_id: user.id,
      event: 'user_created',
      status: 'success',
      metadata: {
        userId: user.id,
        externalId: user.external_id,
        email: user.email,
        role: user.role,
      },
    });

    return {
      id: user.id,
      externalId: user.external_id,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
    };
  }

  async listUsers(orgId: string) {
    const users = await this.userRepo.findByOrgId(orgId);
    return users.map((user) => ({
      id: user.id,
      externalId: user.external_id,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
    }));
  }

  async getUser(orgId: string, userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    if (user.org_id !== orgId) {
      throw new BadRequestException(
        'User does not belong to this organization',
      );
    }

    return {
      id: user.id,
      orgId: user.org_id,
      externalId: user.external_id,
      email: user.email,
      role: user.role,
      status: user.status,
      createdAt: user.created_at,
    };
  }

  async deleteUser(orgId: string, userId: string) {
    const user = await this.userRepo.findById(userId);
    if (!user) throw new NotFoundException(`User ${userId} not found`);
    if (user.org_id !== orgId) {
      throw new BadRequestException(
        'User does not belong to this organization',
      );
    }

    await this.userRepo.update(userId, { status: 'deleted' });

    await this.auditLogRepo.create({
      org_id: orgId,
      user_id: userId,
      event: 'user_deleted',
      status: 'success',
      metadata: {
        userId,
        externalId: user.external_id,
      },
    });

    return { success: true };
  }
}
