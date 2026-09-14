import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'ta:isPublic';

/**
 * Marks ONE route as reachable without a token.
 *
 * Deliberately not usable on a controller class: the existing platform has fifteen
 * class-level @Public() decorators, which is how tenant data ended up answering
 * unauthenticated callers. Every use here is one route, with a reason.
 *
 * @param reason why this specific route is public — recorded in the route inventory.
 */
export const Public = (reason: string) => SetMetadata(IS_PUBLIC_KEY, reason);
