import { Controller, Get, Post, Body, Param, HttpCode } from '@nestjs/common';
import { WalletService, SigningService } from '@app/wallet';
import { DeriveWalletDto } from './dto/derive-wallet.dto';
import { SignTransactionDto } from './dto/sign-transaction.dto';
import { SignTypedDataDto } from './dto/sign-typed-data.dto';
import { SignMessageDto } from './dto/sign-message.dto';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('wallets')
@Controller('wallets')
export class WalletsController {
  constructor(
    private readonly walletService: WalletService,
    private readonly signingService: SigningService,
  ) { }

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
    return this.walletService.deriveWallet(
      dto.orgId,
      dto.userId,
      dto.label,
      dto.chainId,
    );
  }

  @Post(':id/sign-transaction')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign and broadcast a transaction (canonical route)' })
  @ApiResponse({
    status: 200,
    description: 'Transaction signed and broadcast.',
  })
  async signTransaction(
    @Param('id') walletId: string,
    @Body() dto: SignTransactionDto,
  ) {
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

  @Post(':id/sign')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign and broadcast a transaction (backward-compatible alias for /sign-transaction)' })
  @ApiResponse({
    status: 200,
    description: 'Transaction signed and broadcast.',
  })
  async sign(@Param('id') walletId: string, @Body() dto: SignTransactionDto) {
    return this.signTransaction(walletId, dto);
  }

  @Post(':id/sign-typed')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign EIP-712 typed data' })
  @ApiResponse({ status: 200, description: 'Typed data signed.' })
  async signTyped(
    @Param('id') walletId: string,
    @Body() dto: SignTypedDataDto,
  ) {
    return this.signingService.signEip712(dto.orgId, walletId, {
      domain: dto.domain,
      types: dto.types,
      primaryType: dto.primaryType,
      message: dto.message,
    });
  }

  @Post(':id/sign-message')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign a personal message (EIP-191)' })
  @ApiResponse({ status: 200, description: 'Message signed.' })
  async signMessage(
    @Param('id') walletId: string,
    @Body() dto: SignMessageDto,
  ) {
    return this.signingService.signPersonalMessage(dto.orgId, walletId, {
      message: dto.message,
    });
  }
}
