import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ImportModules } from '@src/app.modules.import';

@Module({
  imports: [ConfigModule.forRoot(), EventEmitterModule.forRoot(), ...ImportModules],
})
export class AppModule {}
