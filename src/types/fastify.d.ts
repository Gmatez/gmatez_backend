import { AuthenticatedUser } from './common/decorators/current-user.decorator';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
    rawBody?: string;
  }
}
