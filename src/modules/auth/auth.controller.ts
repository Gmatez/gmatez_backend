import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { IsEmail, IsString, Matches, MinLength } from 'class-validator';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/decorators/public.decorator';
import { AuthService } from './auth.service';

export class RegisterDto {
  @ApiProperty({ example: 'alice@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({ minLength: 10 })
  @IsString()
  @MinLength(10)
  password!: string;

  @ApiProperty({ example: 'Alice' })
  @IsString()
  @MinLength(2)
  displayName!: string;
}

export class LoginDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  password!: string;
}

export class RefreshDto {
  @ApiProperty()
  @IsString()
  refreshToken!: string;
}

export class OtpRequestDto {
  @ApiProperty()
  @IsEmail()
  email!: string;
}

export class PhoneOtpRequestDto {
  @ApiProperty({ example: '+919778741983' })
  @IsString()
  @Matches(/^[+\d][\d\s()-]{7,20}$/)
  phone!: string;
}

export class PhoneOtpVerifyDto {
  @ApiProperty({ example: '+919778741983' })
  @IsString()
  @Matches(/^[+\d][\d\s()-]{7,20}$/)
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @MinLength(4)
  otp!: string;
}

export class OtpVerifyDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(4)
  otp!: string;
}

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @ApiOperation({
    deprecated: true,
    summary: 'Legacy email registration (not the product login path)',
  })
  @Post('register')
  register(@Body() body: RegisterDto) {
    return this.auth.register(body.email, body.password, body.displayName);
  }

  @Public()
  @HttpCode(200)
  @ApiOperation({
    deprecated: true,
    summary: 'Legacy email/password login (admin/e2e)',
  })
  @Post('login')
  login(@Body() body: LoginDto, @Req() req: FastifyRequest) {
    return this.auth.login(body.email, body.password, req.ip);
  }

  @Public()
  @HttpCode(200)
  @Post('refresh')
  refresh(@Body() body: RefreshDto) {
    return this.auth.refresh(body.refreshToken);
  }

  @Public()
  @HttpCode(204)
  @Post('logout')
  async logout(@Body() body: RefreshDto) {
    await this.auth.logout(body.refreshToken);
  }

  @Public()
  @HttpCode(200)
  @ApiOperation({
    deprecated: true,
    summary: 'Legacy email OTP (not the product login path)',
  })
  @Post('otp/request')
  requestOtp(@Body() body: OtpRequestDto) {
    return this.auth.requestOtp(body.email);
  }

  @Public()
  @HttpCode(200)
  @ApiOperation({ deprecated: true, summary: 'Legacy email OTP verify' })
  @Post('otp/verify')
  verifyOtp(@Body() body: OtpVerifyDto) {
    return this.auth.verifyOtp(body.email, body.otp);
  }

  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Request phone OTP (product authentication)' })
  @Post('phone/otp/request')
  requestPhoneOtp(
    @Body() body: PhoneOtpRequestDto,
    @Req() req: FastifyRequest,
  ) {
    return this.auth.requestPhoneOtp(body.phone, req.ip);
  }

  @Public()
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify phone OTP — login or register (product authentication)',
  })
  @Post('phone/otp/verify')
  verifyPhoneOtp(@Body() body: PhoneOtpVerifyDto, @Req() req: FastifyRequest) {
    return this.auth.verifyPhoneOtp(body.phone, body.otp, req.ip);
  }
}
