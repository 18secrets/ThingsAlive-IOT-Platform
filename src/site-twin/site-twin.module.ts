import { Module } from '@nestjs/common';
import { SiteTwinService } from './site-twin.service';

/** The layout's owner. Its controller is registered by the page module, which composes
 * the live view a save returns — a controller here would make the two import each other. */
@Module({
  providers: [SiteTwinService],
  exports: [SiteTwinService],
})
export class SiteTwinModule {}
