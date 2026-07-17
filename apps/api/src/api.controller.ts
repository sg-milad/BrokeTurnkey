import { Body, Controller, Param, Post, UseGuards } from '@nestjs/common';
import { ApiService } from './api.service';
import { WalletService } from '@app/wallet';
import { StampVerifierGuard } from '@app/auth';
import { TxFields } from '@app/crypto-client/interfaces/crypto-client.interfaces';

@Controller()
@UseGuards(StampVerifierGuard)
export class ApiController {
  constructor(
    private readonly apiService: ApiService,
    private readonly walletService: WalletService,
  ) { }

  @Post('organisations/:id/onboard')
  async onboardOrganisation(@Param('id') orgId: string) {
    return await this.walletService.onboardOrganisation(orgId);
  }

  @Post('wallets')
  async deriveWallet(
    @Body() body: { orgId: string; userId: string; label: string },
  ) {
    return await this.walletService.deriveWallet(body.orgId, body.userId, body.label);
  }

  @Post('wallets/:id/sign')
  async requestSign(
    @Param('id') walletId: string,
    @Body() body: { orgId: string; txFields: TxFields },
  ) {
    return await this.walletService.requestSign(body.orgId, walletId, body.txFields);
  }
}
