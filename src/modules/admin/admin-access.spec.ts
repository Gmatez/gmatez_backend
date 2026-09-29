import 'reflect-metadata';
import { ROLES_KEY } from '../../common/decorators/public.decorator';
import { AdminController } from './admin.controller';
import { RechargeController } from '../recharge/recharge.controller';

describe('admin-only routes', () => {
  it('requires the ADMIN role on the admin controller', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminController)).toEqual(['ADMIN']);
  });

  it('requires the ADMIN role on recharge mutations and not on the public list', () => {
    const method = (name: string) =>
      Object.getOwnPropertyDescriptor(RechargeController.prototype, name)
        ?.value as object;
    expect(Reflect.getMetadata(ROLES_KEY, method('create'))).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(ROLES_KEY, method('update'))).toEqual(['ADMIN']);
    expect(Reflect.getMetadata(ROLES_KEY, method('remove'))).toEqual(['ADMIN']);
    expect(
      Reflect.getMetadata(ROLES_KEY, method('listActive')),
    ).toBeUndefined();
  });
});
