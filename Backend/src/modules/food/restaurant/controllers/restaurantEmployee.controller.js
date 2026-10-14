import { sendResponse } from '../../../../utils/response.js';
import * as staff from '../services/restaurantEmployee.service.js';

/**
 * Restaurant panel: Employee Role and Employees (the old store panel's).
 * req.user is the restaurant (owner or permitted staff); the service scopes
 * every read and write to it.
 */
const handle = (message, run, status = 200) => async (req, res, next) => {
    try {
        return sendResponse(res, status, message, await run(req));
    } catch (error) {
        return next(error);
    }
};

export const listPermissionCatalogController = handle('Permissions', () => ({ permissions: staff.listPermissionCatalog() }));
export const listRolesController = handle('Roles', async (req) => ({ roles: await staff.listRoles(req.user) }));
export const createRoleController = handle('Role created', async (req) => ({ role: await staff.createRole(req.user, req.body) }), 201);
export const updateRoleController = handle('Role saved', async (req) => ({ role: await staff.updateRole(req.user, req.params.id, req.body) }));
export const deleteRoleController = handle('Role deleted', (req) => staff.deleteRole(req.user, req.params.id));

export const listEmployeesController = handle('Employees', async (req) => ({ employees: await staff.listEmployees(req.user, req.query) }));
export const getEmployeeController = handle('Employee', async (req) => ({ employee: await staff.getEmployee(req.user, req.params.id) }));
export const createEmployeeController = handle(
    'Employee created',
    async (req) => ({ employee: await staff.createEmployee(req.user, req.body) }),
    201,
);
export const updateEmployeeController = handle('Employee saved', async (req) => ({
    employee: await staff.updateEmployee(req.user, req.params.id, req.body),
}));
export const setEmployeeStatusController = handle('Employee status updated', async (req) => ({
    employee: await staff.setEmployeeStatus(req.user, req.params.id, req.body?.isActive ?? req.body?.status),
}));
export const deleteEmployeeController = handle('Employee deleted', (req) => staff.deleteEmployee(req.user, req.params.id));
