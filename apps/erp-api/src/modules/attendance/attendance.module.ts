import { Module } from '@nestjs/common';

import { AttendanceController } from './attendance.controller.js';
import { AttendanceCoreModule } from './attendance-core.module.js';

/** 考勤 HTTP 外壳；Worker 只导入 AttendanceCoreModule。 */
@Module({
  imports: [AttendanceCoreModule],
  controllers: [AttendanceController],
  exports: [AttendanceCoreModule],
})
export class AttendanceModule {}
