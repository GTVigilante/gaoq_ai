import { Body, Controller, Get, Param, Post } from '@nestjs/common';

import {
  PayrollApplicationService,
  type PayrollRunView,
  type SelfPayslipView,
} from './payroll-application.service.js';

@Controller()
export class PayrollController {
  constructor(private readonly payroll: PayrollApplicationService) {}

  @Post('compensation-profiles')
  async createCompensation(@Body() body: unknown) {
    return this.payroll.createCompensation(body);
  }

  @Post('runs')
  async createRun(@Body() body: unknown): Promise<PayrollRunView> {
    return this.payroll.createRun(body);
  }

  @Post('runs/:id/calculation')
  async calculateRun(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PayrollRunView> {
    return this.payroll.calculateRun(id, body);
  }

  @Post('runs/:id/submission')
  async submitRun(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PayrollRunView> {
    return this.payroll.submitRun(id, body);
  }

  @Post('runs/:id/lock')
  async lockRun(
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<PayrollRunView> {
    return this.payroll.lockRun(id, body);
  }

  @Get('runs/:id')
  async getRun(@Param('id') id: string): Promise<PayrollRunView> {
    return this.payroll.getRun(id);
  }

  @Get('payslips/me/:period')
  async getSelfPayslip(
    @Param('period') period: string,
  ): Promise<SelfPayslipView> {
    return this.payroll.getSelfPayslip(period);
  }
}
