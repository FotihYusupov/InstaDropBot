import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document, Schema as MongooseSchema } from 'mongoose';
import { User } from './user.schema';

export type DownloadDocument = Download & Document;

@Schema({ timestamps: true })
export class Download {
  @Prop({
    type: MongooseSchema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  })
  userId: MongooseSchema.Types.ObjectId;

  @Prop({ required: true })
  url: string;

  @Prop({
    required: true,
    enum: ['PENDING', 'COMPLETED', 'FAILED'],
    default: 'PENDING',
    index: true,
  })
  status: string;

  @Prop({ type: Number })
  fileSize?: number;

  @Prop({ type: Number })
  duration?: number; // processing duration in ms

  @Prop({ type: String })
  errorMessage?: string;

  @Prop({ type: String, index: true })
  instagramAccount?: string;
}

export const DownloadSchema = SchemaFactory.createForClass(Download);
DownloadSchema.index({ createdAt: -1 });
DownloadSchema.index({ status: 1, createdAt: -1 });
