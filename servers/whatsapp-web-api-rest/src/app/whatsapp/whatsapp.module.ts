import { Module } from '@nestjs/common';
import { WebhookService } from '../webhook/webhook.service';
import { WhatsappController } from './whatsapp.controller';
import { WhatsappService } from './whatsapp.service';

@Module({
  imports: [],
  providers: [WhatsappService, WebhookService],
  controllers: [WhatsappController],
  exports: [],
})
export default class WhatsappModule {}
