import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { CursorPaginationQueryDto } from '../../common/dto/pagination.dto';
import { WalletService } from './wallet.service';

@ApiTags('wallet')
@ApiBearerAuth()
@Controller('wallet')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

  @Get()
  async getMine(@CurrentUser() user: { userId: string }) {
    const w = await this.wallet.getByUserId(user.userId);
    return {
      currency: w.currency,
      availableBalanceCents: w.availableBalanceCents,
      heldBalanceCents: w.heldBalanceCents,
    };
  }

  @Get('ledger')
  async ledger(
    @CurrentUser() user: { userId: string },
    @Query() query: CursorPaginationQueryDto,
  ) {
    return this.wallet.listLedger(user.userId, query.limit, query.cursor);
  }

  @Get('earnings')
  earnings(@CurrentUser() user: { userId: string }) {
    return this.wallet.earningsSummary(user.userId);
  }
}
