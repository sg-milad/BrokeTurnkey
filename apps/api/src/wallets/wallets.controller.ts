import { Controller, Post, Body, Param, HttpCode } from '@nestjs/common';
import { WalletService } from '@app/wallet';
import { DeriveWalletDto } from './dto/derive-wallet.dto';
import { SignTransactionDto } from './dto/sign-transaction.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
    constructor(private readonly walletService: WalletService) { }

    @Post()
    @ApiOperation({ summary: 'Derive a new wallet for an organization' })
    @ApiResponse({ status: 201, description: 'Wallet derived successfully.' })
    async derive(@Body() dto: DeriveWalletDto) {
        return this.walletService.deriveWallet(dto.orgId, dto.userId, dto.label);
    }

    @Post(':id/sign')
    @HttpCode(200)
    @ApiOperation({ summary: 'Sign a transaction with a wallet' })
    @ApiResponse({ status: 200, description: 'Transaction signed successfully.' })
    async sign(@Param('id') walletId: string, @Body() dto: SignTransactionDto) {
        return this.walletService.requestSign(dto.orgId, walletId, dto.txFields);
    }
}