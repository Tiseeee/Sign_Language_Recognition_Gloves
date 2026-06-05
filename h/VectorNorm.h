//
// Created by tise on 2026/5/28.
//

#ifndef HANDS_SEE_VECTORNORM_H
#define HANDS_SEE_VECTORNORM_H

#include <fstream>
#include "HandStruct.h"
using namespace std;

struct VectorResult {
   //大拇指
   int RightHandFirst;
   //食指
   int RightHandSecond;
   //其余三个手指
   int RightHandThird;
   //左手
   int LeftHandFirst;
   int LeftHandSecond;
   int LeftHandThird;
   //右手
   float gyro1;//手腕
   float gyro2;//小臂
   //左手
   float gyro3;
   float gyro4;
};

VectorResult VZero {0,0, 0,0,0,0,0,0,};

VectorResult calculate(struct HandStruct &handStruct){
   VectorResult Vtrl=VZero;
   Vtrl.RightHandFirst = handStruct.finger1;
   Vtrl.RightHandSecond = handStruct.finger2;
   Vtrl.RightHandThird = (handStruct.finger3+handStruct.finger4+handStruct.finger5)/3;
   Vtrl.LeftHandFirst = handStruct.finger6;
   Vtrl.LeftHandSecond = handStruct.finger7;
   Vtrl.LeftHandThird = (handStruct.finger8+handStruct.finger9+handStruct.finger10)/3;
   Vtrl.gyro1=handStruct.gyro1;
   Vtrl.gyro2=handStruct.gyro2;
   Vtrl.gyro3=handStruct.gyro3;
   Vtrl.gyro4=handStruct.gyro4;
   return Vtrl;
}

void output(VectorResult &Vtrl) {
   ofstream fout;
   fout.open("Data_Record.json", ios::app);
      fout << "Record{"<<endl;
      fout <<"RightHandFirst:"<< Vtrl.RightHandFirst <<","<<'\n';
      fout << "RightHandSecond:"<<Vtrl.RightHandSecond <<","<< '\n';
      fout << "RightHandThird:"<<Vtrl.RightHandThird <<","<< '\n';
      fout << "LeftHandFirst:"<<Vtrl.LeftHandFirst <<","<< '\n';
      fout << "LeftHandSecond:"<<Vtrl.LeftHandSecond <<","<< '\n';
      fout << "LeftHandThird:"<<Vtrl.LeftHandThird <<","<< '\n';
      fout << "gyro1:"<<Vtrl.gyro1 <<","<< '\n';
      fout << "gyro2:"<<Vtrl.gyro2 <<","<< '\n';
      fout << "gyro3:"<<Vtrl.gyro3 <<","<< '\n';
      fout << "gyro4:"<<Vtrl.gyro4 <<","<< '\n';
      fout <<"}" << endl;
      fout<<'\n';
   fout.close();
}

#endif //HANDS_SEE_VECTORNORM_H
