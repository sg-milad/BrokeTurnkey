import { Controller, Get, Post, Body, Param, HttpCode } from '@nestjs/common';
import { WalletService } from '@app/wallet';
import { DeriveWalletDto } from './dto/derive-wallet.dto';
import { SignTransactionDto } from './dto/sign-transaction.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
    constructor(private readonly walletService: WalletService) { }

    @Get(':id')
    @ApiOperation({ summary: 'Get wallet details by id' })
    @ApiResponse({ status: 200, description: 'Wallet found.' })
    async findOne(@Param('id') id: string) {
        return this.walletService.getWalletById(id);
    }

    @Get(':id/signing-requests')
    @ApiOperation({ summary: 'List signing requests for a wallet' })
    @ApiResponse({ status: 200, description: 'Signing requests returned.' })
    async listSigningRequests(@Param('id') id: string) {
        return this.walletService.listSigningRequestsByWalletId(id);
    }

    @Post()
    @ApiOperation({ summary: 'Derive a new wallet for an organization' })
    @ApiResponse({ status: 201, description: 'Wallet derived successfully.' })
    async derive(@Body() dto: DeriveWalletDto) {
        return this.walletService.deriveWallet(dto.orgId, dto.userId, dto.label);
    }

    @Post(':id/sign')
    @HttpCode(200)
    @ApiOperation({ summary: 'Sign and broadcast a transaction' })
    @ApiResponse({ status: 200, description: 'Transaction signed and broadcast.' })
    async sign(@Param('id') walletId: string, @Body() dto: SignTransactionDto) {
        return this.walletService.requestSign(dto.orgId, walletId, {
            chainId: dto.txFields.chainId,
            to: dto.txFields.to,
            value: dto.txFields.value,
            data: dto.txFields.data,
            gasLimit: dto.txFields.gasLimit,
            maxFeePerGas: dto.txFields.maxFeePerGas,
            maxPriorityFeePerGas: dto.txFields.maxPriorityFeePerGas,
        });
    }
}