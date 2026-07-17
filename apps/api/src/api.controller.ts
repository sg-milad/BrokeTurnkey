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

}
