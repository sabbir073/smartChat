import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  availabilitySchema,
  createDepartmentSchema,
  createRoleSchema,
  inviteMemberSchema,
  updateDepartmentSchema,
  updateMemberSchema,
  updateRoleSchema,
} from '@smartchat/validation';
import type { Container } from '../container.js';
import { requireTenant } from '../plugins/auth.js';
import { created, noContent, ok } from '../lib/reply.js';
import { parseBody, parseParams } from '../lib/validate.js';
import { toMemberDto } from './dto.js';

const idParam = z.object({ id: z.string().uuid() });

/**
 * Team, roles and departments.
 *
 * Every route is tenant-scoped by the preHandler, and every id in a body is re-checked against
 * the caller's own account inside the service — an id that belongs to somebody else is a
 * validation failure, not a silent write.
 */
export async function teamRoutes(app: FastifyInstance, container: Container): Promise<void> {
  app.addHook('preHandler', app.authenticateTenant);

  // --- members --------------------------------------------------------------

  app.get('/team/members', async (request, reply) => {
    const tenant = requireTenant(request);
    const members = await container.team.listMembers(tenant);
    return ok(reply, { members: members.map(toMemberDto) });
  });

  app.post('/team/members', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(inviteMemberSchema, request.body);
    const result = await container.team.invite(tenant, input, tenant.actorName ?? 'A colleague');
    return created(reply, { id: result.member.id, status: result.member.status });
  });

  app.patch('/team/members/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateMemberSchema, request.body);
    const member = await container.team.updateMember(tenant, id, input);
    return ok(reply, toMemberDto(member));
  });

  app.delete('/team/members/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.team.removeMember(tenant, id);
    return noContent(reply);
  });

  // --- invitations ----------------------------------------------------------

  app.get('/team/invitations', async (request, reply) => {
    const tenant = requireTenant(request);
    return ok(reply, { invitations: await container.team.listInvitations(tenant) });
  });

  app.post('/team/invitations/:id/resend', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.team.resendInvitation(tenant, id, tenant.actorName ?? 'A colleague');
    return noContent(reply);
  });

  app.delete('/team/invitations/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.team.revokeInvitation(tenant, id);
    return noContent(reply);
  });

  // --- the caller's own availability ---------------------------------------

  app.get('/team/availability', async (request, reply) => {
    const tenant = requireTenant(request);
    return ok(reply, { availability: await container.team.getAvailability(tenant) });
  });

  app.put('/team/availability', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(availabilitySchema, request.body);
    await container.team.setAvailability(tenant, input.availability);
    return ok(reply, { availability: input.availability });
  });

  // --- roles ----------------------------------------------------------------

  app.get('/team/roles', async (request, reply) => {
    const tenant = requireTenant(request);
    const roles = await container.team.listRoles(tenant);
    return ok(reply, {
      roles: roles.map((role) => ({
        id: role.id,
        key: role.key,
        name: role.name,
        description: role.description,
        permissions: role.permissions,
        isSystem: role.isSystem,
      })),
    });
  });

  app.post('/team/roles', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(createRoleSchema, request.body);
    const role = await container.team.createRole(tenant, input);
    return created(reply, { id: role.id, key: role.key, name: role.name });
  });

  app.patch('/team/roles/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateRoleSchema, request.body);
    const role = await container.team.updateRole(tenant, id, input);
    return ok(reply, {
      id: role.id,
      key: role.key,
      name: role.name,
      permissions: role.permissions,
    });
  });

  app.delete('/team/roles/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.team.deleteRole(tenant, id);
    return noContent(reply);
  });

  // --- departments ----------------------------------------------------------

  app.get('/team/departments', async (request, reply) => {
    const tenant = requireTenant(request);
    const departments = await container.team.listDepartments(tenant);
    return ok(
      reply,
      departments.map((department) => ({
        id: department.id,
        key: department.key,
        name: department.name,
        description: department.description,
        isDefault: department.isDefault,
      })),
    );
  });

  app.post('/team/departments', async (request, reply) => {
    const tenant = requireTenant(request);
    const input = parseBody(createDepartmentSchema, request.body);
    const department = await container.team.createDepartment(tenant, input);
    return created(reply, { id: department.id, key: department.key, name: department.name });
  });

  app.patch('/team/departments/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    const input = parseBody(updateDepartmentSchema, request.body);
    const department = await container.team.updateDepartment(tenant, id, input);
    return ok(reply, {
      id: department.id,
      key: department.key,
      name: department.name,
      isDefault: department.isDefault,
    });
  });

  app.delete('/team/departments/:id', async (request, reply) => {
    const tenant = requireTenant(request);
    const { id } = parseParams(idParam, request.params);
    await container.team.deleteDepartment(tenant, id);
    return noContent(reply);
  });
}
