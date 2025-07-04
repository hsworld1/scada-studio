// /* eslint-disable @typescript-eslint/no-unused-vars */
import {
  Injectable,
  NotFoundException,
  OnModuleInit,
  ConflictException,
  UnauthorizedException,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In } from 'typeorm';
import * as bcrypt from 'bcrypt';
import { User, UserStatus } from './entities/user.entity';
import { Role } from './entities/role.entity';
import { CreateUserDto } from './dto/create-user.dto';
import { CasbinService } from '../casbin/casbin.service';
import { AppLogger } from '@app/logger-lib';
import { Tenant } from '../tenant/entities/tenant.entity';
import { Group } from './entities/group.entity';
import { FindUsersDto } from './dto/find-users.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { SetUserStatusDto } from './dto/set-user-status.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { nanoid } from 'nanoid';
import { I18nService } from 'nestjs-i18n';
import { AuditLogService } from '../audit/audit-log.service';

interface SsoPayload {
  provider: string;
  providerId: string;
  email: string;
  username: string;
  tenantSlug: string;
}

@Injectable()
export class UserService implements OnModuleInit {
  private readonly context = UserService.name;

  constructor(
    @InjectRepository(User) private userRepository: Repository<User>,
    @InjectRepository(Role) private roleRepository: Repository<Role>,
    @InjectRepository(Group) private groupRepository: Repository<Group>,
    @InjectRepository(Tenant) private tenantRepository: Repository<Tenant>,
    private casbinService: CasbinService,
    private readonly logger: AppLogger,
    private readonly i18n: I18nService,
    private readonly auditLogService: AuditLogService,
  ) {
    this.logger.setContext(this.context);
  }

  async onModuleInit() {
    await this.seedDefaultTenant();
  }

  /**
   * 校验密码强度：必须包含大写、小写、数字、特殊字符，且长度>=8
   */
  private isStrongPassword(password: string): boolean {
    return /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]).{8,}$/.test(
      password,
    );
  }

  async create(createUserDto: CreateUserDto): Promise<User> {
    const {
      username,
      password,
      roleNames,
      groupIds,
      tenantId,
      email,
      phone,
      description,
    } = createUserDto;

    const tenant = await this.tenantRepository.findOneBy({ id: tenantId });
    if (!tenant) {
      throw new NotFoundException(this.i18n.t('common.tenant_not_found'));
    }

    const orConditions: Array<{
      username?: string;
      email?: string;
      phone?: string;
      tenantId: number;
      description?: string;
    }> = [];
    if (username) orConditions.push({ username, tenantId });
    if (email) orConditions.push({ email, tenantId });
    if (phone) orConditions.push({ phone, tenantId });
    if (description) orConditions.push({ description, tenantId });

    if (orConditions.length > 0) {
      const existingUser = await this.userRepository.findOne({
        where: orConditions,
        withDeleted: true,
      });
      if (existingUser) {
        if (existingUser.username === username) {
          throw new ConflictException(
            this.i18n.t('common.user_exists', { args: { username } }),
          );
        }
        if (email && existingUser.email === email) {
          throw new ConflictException(
            this.i18n.t('common.email_exists', { args: { email } }),
          );
        }
        if (phone && existingUser.phone === phone) {
          throw new ConflictException(
            this.i18n.t('common.phone_exists', { args: { phone } }),
          );
        }
      }
    }

    const roles = await this.roleRepository.find({
      where: { name: In(roleNames), tenantId },
    });
    if (roles.length !== roleNames.length) {
      throw new NotFoundException(this.i18n.t('common.role_not_found'));
    }

    let groups: Group[] = [];
    if (groupIds && groupIds.length > 0) {
      groups = await this.groupRepository.find({
        where: { id: In(groupIds), tenantId },
      });
      if (groups.length !== groupIds.length) {
        throw new NotFoundException(this.i18n.t('common.group_not_found'));
      }
    }

    // 密码强度校验
    if (!this.isStrongPassword(password)) {
      throw new BadRequestException(this.i18n.t('common.password_too_weak'));
    }

    const user = this.userRepository.create({
      username,
      password,
      email,
      phone,
      tenantId,
      roles,
      groups,
      description,
    });
    const savedUser = await this.userRepository.save(user);

    for (const role of roles) {
      await this.casbinService.addRoleForUser(
        savedUser.id.toString(),
        role.name,
        tenantId.toString(),
      );
    }
    this.logger.log(
      `Successfully created user: ${username} in tenant ${tenantId}`,
    );
    const { password: _, ...result } = savedUser;
    // 自动审计
    await this.auditLogService.audit({
      userId: createUserDto.operatorId,
      tenantId,
      action: 'create',
      resource: 'user',
      targetId: savedUser.id.toString(),
      detail: { ...createUserDto, password: undefined },
      result: 'success',
    });
    return result as User;
  }

  async findAll(
    findUsersDto: FindUsersDto,
  ): Promise<{ data: User[]; total: number }> {
    const {
      page = 1,
      pageSize = 10,
      searchKeyword,
      roleNames,
      groupIds,
      status,
      tenantId,
    } = findUsersDto;

    const queryBuilder = this.userRepository
      .createQueryBuilder('user')
      .leftJoinAndSelect('user.roles', 'role')
      .leftJoinAndSelect('user.groups', 'group')
      .where('user.tenantId = :tenantId', { tenantId });

    if (searchKeyword) {
      queryBuilder.andWhere(
        '(user.username LIKE :keyword OR user.email LIKE :keyword OR user.phone LIKE :keyword)',
        {
          keyword: `%${searchKeyword}%`,
        },
      );
    }

    if (status) {
      queryBuilder.andWhere('user.status = :status', { status });
    }

    if (roleNames && roleNames.length > 0) {
      queryBuilder.andWhere('role.name IN (:...roleNames)', { roleNames });
    }

    if (groupIds && groupIds.length > 0) {
      queryBuilder.andWhere('group.id IN (:...groupIds)', { groupIds });
    }

    const [data, total] = await queryBuilder
      .orderBy('user.createdAt', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize)
      .getManyAndCount();

    const sanitizedData = data.map((user) => {
      const { password: _, ...result } = user;
      return result as User;
    });

    return { data: sanitizedData, total };
  }

  async update(updateUserDto: UpdateUserDto): Promise<User> {
    const {
      userId,
      tenantId,
      email,
      phone,
      status,
      roleNames,
      groupIds,
      description,
    } = updateUserDto;

    const user = await this.userRepository.findOne({
      where: { id: userId, tenantId },
      relations: ['roles', 'groups'],
    });
    if (!user) {
      throw new NotFoundException(this.i18n.t('common.user_not_found'));
    }

    if (email) user.email = email;
    if (phone) user.phone = phone;
    if (status) user.status = status;
    if (description !== undefined) user.description = description;

    if (roleNames) {
      const newRoles = await this.roleRepository.find({
        where: { name: In(roleNames), tenantId },
      });
      if (newRoles.length !== roleNames.length) {
        throw new NotFoundException(this.i18n.t('common.role_not_found'));
      }
      user.roles = newRoles;
      await this.casbinService
        .getEnforcer()
        .deleteRolesForUser(user.id.toString(), tenantId.toString());
      for (const role of newRoles) {
        await this.casbinService.addRoleForUser(
          user.id.toString(),
          role.name,
          tenantId.toString(),
        );
      }
    }

    if (groupIds) {
      user.groups = await this.groupRepository.find({
        where: { id: In(groupIds), tenantId },
      });
    }

    const updatedUser = await this.userRepository.save(user);
    const { password: _password, ...result } = updatedUser;
    // 自动审计
    await this.auditLogService.audit({
      userId: updateUserDto.operatorId,
      tenantId,
      action: 'update',
      resource: 'user',
      targetId: userId.toString(),
      detail: { ...updateUserDto },
      result: 'success',
    });
    return result as User;
  }

  async setStatus(
    setUserStatusDto: SetUserStatusDto,
  ): Promise<{ success: boolean }> {
    const { userId, tenantId, status } = setUserStatusDto;
    const result = await this.userRepository.update(
      { id: userId, tenantId },
      { status },
    );

    if (result.affected === 0) {
      throw new NotFoundException(this.i18n.t('common.user_not_found'));
    }

    // 自动审计
    await this.auditLogService.audit({
      userId: setUserStatusDto.operatorId,
      tenantId,
      action: 'setStatus',
      resource: 'user',
      targetId: userId.toString(),
      detail: { ...setUserStatusDto },
      result: 'success',
    });
    return { success: true };
  }

  async remove(
    userId: number,
    tenantId: number,
    operatorId?: number,
  ): Promise<{ success: boolean }> {
    const result = await this.userRepository.softDelete({
      id: userId,
      tenantId,
    });

    if (result.affected === 0) {
      throw new NotFoundException(this.i18n.t('common.user_not_found'));
    }

    await this.casbinService.getEnforcer().deleteUser(userId.toString());
    this.logger.log(
      `Soft deleted user ${userId} and cleared their casbin policies.`,
    );

    // 自动审计
    await this.auditLogService.audit({
      userId: operatorId,
      tenantId,
      action: 'delete',
      resource: 'user',
      targetId: userId.toString(),
      result: 'success',
    });
    return { success: true };
  }

  async findOneByUsername(
    username: string,
    tenantId: number,
  ): Promise<User | null> {
    return this.userRepository.findOne({
      where: { username, tenantId },
      relations: ['roles', 'tenant'],
    });
  }

  async findOneById(id: number, tenantId: number): Promise<User> {
    const user = await this.userRepository.findOne({
      where: { id, tenantId },
      relations: ['roles', 'groups', 'tenant'],
    });
    if (!user) {
      throw new NotFoundException(this.i18n.t('common.user_not_found'));
    }
    return user;
  }

  async getProfile(
    userId: number,
    tenantId: number,
  ): Promise<
    Omit<User, 'password' | 'hashPasswordOnInsert' | 'hashPasswordOnUpdate'>
  > {
    const user = await this.findOneById(userId, tenantId);
    const { password: _password, ...result } = user;
    return result;
  }

  async updateProfile(
    updateProfileDto: UpdateProfileDto,
  ): Promise<
    Omit<User, 'password' | 'hashPasswordOnInsert' | 'hashPasswordOnUpdate'>
  > {
    const { currentUserId, tenantId, email, phone, preferences } =
      updateProfileDto;

    const user = await this.findOneById(currentUserId, tenantId);

    if (email && email !== user.email) {
      const existing = await this.userRepository.findOneBy({ email, tenantId });
      if (existing) {
        throw new ConflictException(
          this.i18n.t('common.email_exists', { args: { email } }),
        );
      }
      user.email = email;
    }

    if (phone && phone !== user.phone) {
      const existing = await this.userRepository.findOneBy({ phone, tenantId });
      if (existing) {
        throw new ConflictException(
          this.i18n.t('common.phone_exists', { args: { phone } }),
        );
      }
      user.phone = phone;
    }

    if (preferences) {
      user.preferences = preferences;
    }

    const updatedUser = await this.userRepository.save(user);
    const { password: _password, ...result } = updatedUser;
    // 自动审计
    await this.auditLogService.audit({
      userId: updateProfileDto.currentUserId,
      tenantId: updateProfileDto.tenantId,
      action: 'updateProfile',
      resource: 'user',
      targetId: updateProfileDto.currentUserId.toString(),
      detail: { ...updateProfileDto },
      result: 'success',
    });
    return result;
  }

  async changePassword(
    changePasswordDto: ChangePasswordDto,
  ): Promise<{ success: boolean }> {
    const { currentUserId, tenantId, oldPassword, newPassword } =
      changePasswordDto;

    const user = await this.findOneById(currentUserId, tenantId);

    const isMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isMatch) {
      throw new UnauthorizedException(
        this.i18n.t('common.incorrect_old_password'),
      );
    }

    // 密码强度校验
    if (!this.isStrongPassword(newPassword)) {
      throw new BadRequestException(this.i18n.t('common.password_too_weak'));
    }

    user.password = newPassword;
    await this.userRepository.save(user);

    this.logger.log(
      `User ${user.username} (ID: ${user.id}) changed their password.`,
    );

    // 自动审计
    await this.auditLogService.audit({
      userId: changePasswordDto.currentUserId,
      tenantId: changePasswordDto.tenantId,
      action: 'changePassword',
      resource: 'user',
      targetId: changePasswordDto.currentUserId.toString(),
      detail: {},
      result: 'success',
    });
    return { success: true };
  }

  async findOrCreateBySSO(payload: SsoPayload): Promise<User> {
    const { email, username, tenantSlug } = payload;

    const tenant = await this.tenantRepository.findOneBy({ slug: tenantSlug });
    if (!tenant) {
      this.logger.error(
        `SSO failed: Tenant with slug '${tenantSlug}' not found.`,
      );
      throw new NotFoundException(this.i18n.t('common.tenant_not_found'));
    }

    const user = await this.userRepository.findOne({
      where: { email, tenantId: tenant.id },
      relations: ['roles', 'tenant'],
    });

    if (user) {
      if (user.status !== UserStatus.ACTIVE) {
        throw new UnauthorizedException(this.i18n.t('common.user_inactive'));
      }
      return user;
    }

    this.logger.log(
      `User with email '${email}' not found. Creating a new user via SSO.`,
    );

    const defaultRoleName = 'developer';
    const defaultRole = await this.roleRepository.findOneBy({
      name: defaultRoleName,
      tenantId: tenant.id,
    });
    if (!defaultRole) {
      this.logger.error(
        `SSO user creation failed: Default role '${defaultRoleName}' not found in tenant ${tenant.id}.`,
      );
      throw new InternalServerErrorException(
        this.i18n.t('common.default_role_not_configured'),
      );
    }

    const randomPassword = nanoid();
    const newUser = await this.create({
      username: username,
      password: randomPassword,
      email: email,
      tenantId: tenant.id,
      roleNames: [defaultRoleName],
    });

    return this.findOneById(newUser.id, tenant.id);
  }

  private async seedDefaultTenant() {
    const defaultTenantSlug = 'default';
    let tenant = await this.tenantRepository.findOneBy({
      slug: defaultTenantSlug,
    });

    if (!tenant) {
      this.logger.log('Seeding default tenant...');
      tenant = await this.tenantRepository.save({
        name: 'Default Tenant',
        slug: defaultTenantSlug,
      });
      this.logger.log(`Default tenant seeded with ID: ${tenant.id}`);
    }

    await this.initTenantData(tenant);
  }

  /**
   * 初始化租户的基础角色、权限策略和超级管理员账号。
   * @param tenant 新建的租户实体
   */
  async initTenantData(tenant: Tenant) {
    const tenantId = tenant.id;
    const tenantIdStr = tenant.id.toString();
    const rolesToSeed = ['super-admin', 'developer'];
    const existingRolesCount = await this.roleRepository.count({
      where: { tenantId },
    });
    if (existingRolesCount === 0) {
      this.logger.log(`Seeding initial roles for tenant ${tenantId}...`);
      const roleEntities = rolesToSeed.map((name) => ({
        name,
        tenantId,
        description: `The ${name} role`,
      }));
      await this.roleRepository.save(roleEntities);
      this.logger.log('Initial roles seeded.');
    }
    const enforcer = this.casbinService.getEnforcer();
    const initialPolicies = [
      ['super-admin', tenantIdStr, 'all', 'manage'],
      ['super-admin', tenantIdStr, 'user', 'create'],
      ['super-admin', tenantIdStr, 'user', 'read'],
      ['super-admin', tenantIdStr, 'user', 'update'],
      ['super-admin', tenantIdStr, 'user', 'delete'],
      ['super-admin', tenantIdStr, 'user', 'manage_status'],
      ['super-admin', tenantIdStr, 'role', 'create'],
      ['super-admin', tenantIdStr, 'role', 'read'],
      ['super-admin', tenantIdStr, 'role', 'update'],
      ['super-admin', tenantIdStr, 'role', 'delete'],
      ['super-admin', tenantIdStr, 'group', 'create'],
      ['super-admin', tenantIdStr, 'group', 'read'],
      ['super-admin', tenantIdStr, 'group', 'update'],
      ['super-admin', tenantIdStr, 'group', 'delete'],
      ['super-admin', tenantIdStr, 'permission', 'manage'],
      ['super-admin', tenantIdStr, 'tenant', 'create'],
      ['super-admin', tenantIdStr, 'tenant', 'update'],
      ['super-admin', tenantIdStr, 'tenant', 'delete'],
      ['super-admin', tenantIdStr, 'tenant', 'read'],
      ['developer', tenantIdStr, 'workbench', 'access'],
      ['developer', tenantIdStr, 'project', 'manage'],
    ];
    for (const p of initialPolicies) {
      if (!(await enforcer.hasPolicy(...p))) {
        await enforcer.addPolicy(...p);
      }
    }
    const adminExists = await this.userRepository.findOne({
      where: { username: 'admin', tenantId },
    });
    if (!adminExists) {
      this.logger.log(`Seeding super admin for tenant ${tenantId}...`);
      await this.create({
        username: 'admin',
        password: process.env.ADMIN_PASSWORD || 'admin123',
        roleNames: ['super-admin'],
        tenantId,
      });
      this.logger.log('Super admin seeded.');
    }
  }
}
